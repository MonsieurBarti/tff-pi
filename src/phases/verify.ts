import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteArtifact, readArtifact, writeArtifact } from "../common/artifacts.js";
import { milestoneBranchName } from "../common/branch-naming.js";
import { createCheckpoint } from "../common/checkpoint.js";
import { commitCommand } from "../common/commit.js";
import { compressIfEnabled } from "../common/compress.js";
import { getLatestPhaseRun, getMilestone, resetTasksToOpen } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { auditVerificationAgainstCapture, formatAuditReport } from "../common/evidence-auditor.js";
import { getDiff } from "../common/git.js";
import {
	formatMechanicalReport,
	runMechanicalVerification,
} from "../common/mechanical-verifier.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import {
	type FinalizeInput,
	prepareDispatch,
	registerPhaseFinalizer,
} from "../common/subagent-dispatcher.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { detectVerifyCommands } from "../common/verify-commands.js";
import { getWorktreePath } from "../common/worktree.js";
import { predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

function buildVerifyTaskBody(p: {
	sLabel: string;
	wtPath: string;
	testInstruction: string;
	compressLine: string;
}): string {
	const lines = [
		`Slice: ${p.sLabel}`,
		"",
		`Work inside ${p.wtPath}. Read-only except for writes to ${p.wtPath}/.pi/.tff/artifacts/.`,
		"",
		"1. For every AC in SPEC.md, inspect the diff + worktree code and decide PASS / FAIL with one-line evidence (test name or file:line).",
		`2. If the mechanical verification report above shows all passed, cite it; otherwise run the project tests (${p.testInstruction}) and record the exact command + outcome.`,
		"3. Write <cwd>/.pi/.tff/artifacts/VERIFICATION.md containing:",
		"   - AC checklist with `- [x]` / `- [ ]` per AC-N",
		"   - Test command run + pass/fail counts",
		"   - On any FAIL: which PLAN.md task(s) need rework",
	];
	if (p.compressLine.length > 0) lines.push(p.compressLine);
	lines.push(
		"4. Write <cwd>/.pi/.tff/artifacts/PR.md — concise reviewer-facing description (≤20 lines), uncompressed regardless of artifact compression. Use PR body template above if present.",
		"5. End with:",
		"   STATUS: <DONE|DONE_WITH_CONCERNS|BLOCKED>",
		"   EVIDENCE: <one-line summary>",
	);
	return lines.join("\n");
}

export const verifyPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "verify",
		});

		closePredecessorIfReady(pi, db, root, slice, "verify", predecessorPhase, verifyPhaseArtifacts);

		const wtPath = getWorktreePath(root, sLabel);
		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";

		let testInstruction: string;
		if (settings.test_command === "disabled") {
			testInstruction = "Test execution is disabled. Skip the test stage.";
		} else if (settings.test_command) {
			testInstruction = `Run tests with: ${settings.test_command}`;
		} else {
			testInstruction =
				"Auto-discover the test command from project files (package.json, Makefile, etc.). Run scoped tests for changed files where possible.";
		}

		const milestoneRow = getMilestone(db, slice.milestoneId);
		if (!milestoneRow) {
			return { success: false, retry: false, error: `Milestone not found: ${slice.milestoneId}` };
		}
		const milestoneBranch = milestoneBranchName(milestoneRow);
		const rawDiff = getDiff(milestoneBranch, wtPath) ?? "";
		const diffLines = rawDiff.split("\n");
		const MAX_DIFF_LINES = 800;
		const diff =
			diffLines.length > MAX_DIFF_LINES
				? `${diffLines.slice(0, MAX_DIFF_LINES).join("\n")}\n\n[... ${diffLines.length - MAX_DIFF_LINES} more lines truncated; inspect the worktree directly for full diff ...]`
				: rawDiff;

		if (diff.trim() === "") {
			const error = `No diff between ${milestoneBranch} and the slice worktree. The execute phase produced no changes — re-run execute before verifying.`;
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "verify",
				error,
			});
			return { success: false, retry: false };
		}

		// --- Mechanical verification (runs independently of AI) ---
		const verifyCommands = await detectVerifyCommands(root, settings);
		if (verifyCommands.length > 0) {
			const report = await runMechanicalVerification(verifyCommands, wtPath);
			const reportMd = formatMechanicalReport(report);
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/VERIFICATION-MECHANICAL.md`,
				compressIfEnabled(reportMd, "artifacts", settings),
			);

			if (!report.allPassed) {
				const failures = report.commands
					.filter((c) => !c.passed)
					.map(
						(c) =>
							`- ${c.name}: exit ${c.exitCode}${c.stderr ? `\n  ${c.stderr.split("\n")[0]}` : ""}`,
					)
					.join("\n");

				resetTasksToOpen(db, slice.id);

				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "verify",
					error: "Mechanical verification failed",
				});

				return {
					success: false,
					retry: true,
					feedback: `Mechanical verification found failures:\n${failures}\n\nFull report written to VERIFICATION-MECHANICAL.md. Verify phase failed. Stop here; the user will decide whether to retry with \`/tff execute ${sLabel}\`.`,
				};
			}
		}

		// Post-verify checkpoint
		createCheckpoint(wtPath, sLabel, "post-verify");

		// --- Register verify finalizer (captures {db, pi, root, slice,
		// milestoneNumber, wtPath, mLabel, sLabel} by ref) ---
		registerPhaseFinalizer("verify", async ({ result, calls }: FinalizeInput) => {
			const r = result.results[0];

			// AC-17: BLOCKED / malformed
			if (!r || r.status === "BLOCKED") {
				resetTasksToOpen(db, slice.id);
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "verify",
					error: r?.evidence ?? "BLOCKED",
				});
				return;
			}

			// AC-18: missing artifact
			const artifactsDir = join(wtPath, ".pi", ".tff", "artifacts");
			const vSrc = join(artifactsDir, "VERIFICATION.md");
			const prSrc = join(artifactsDir, "PR.md");
			if (!existsSync(vSrc) || !existsSync(prSrc)) {
				const missing = !existsSync(vSrc) ? "VERIFICATION.md" : "PR.md";
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "verify",
					error: `missing ${missing}`,
				});
				return;
			}

			const vMd = readFileSync(vSrc, "utf-8");
			const prMd = readFileSync(prSrc, "utf-8");
			const auditReport = auditVerificationAgainstCapture(vMd, calls);

			const sliceRel = `milestones/${mLabel}/slices/${sLabel}`;
			const vRel = `${sliceRel}/VERIFICATION.md`;
			const auditRel = `${sliceRel}/VERIFICATION-AUDIT.md`;
			const blockedRel = `${sliceRel}/.audit-blocked`;
			const prRel = `${sliceRel}/PR.md`;

			// AC-19: audit mismatch — copy V.md, write audit report + .audit-blocked, fail
			if (auditReport.hasMismatches) {
				writeArtifact(root, vRel, vMd);
				writeArtifact(root, auditRel, formatAuditReport(auditReport));
				writeArtifact(root, blockedRel, "Audit found mismatches. See VERIFICATION-AUDIT.md.\n");
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "verify",
					error: `audit mismatch: ${auditReport.summary.mismatch}`,
				});
				return;
			}

			// AC-20: clean — clear stale markers from a prior mismatch run
			deleteArtifact(root, blockedRel);
			deleteArtifact(root, auditRel);

			// AC-24: idempotency — if the verify phase_run is already completed
			// (second invocation after a crash between commits and phase_complete
			// emit), skip both commitCommand calls. Re-running them would fail
			// preconditions: slice has been promoted out of "verifying" and the
			// phase_run is no longer "started". We still overwrite the artifacts
			// (they may have been modified) and re-emit phase_complete below.
			const latestRun = getLatestPhaseRun(db, slice.id, "verify");
			const alreadyCompleted = latestRun?.status === "completed";

			if (!alreadyCompleted) {
				// AC-22: write PR.md + commit first. Done BEFORE write-verification
				// because projectPhaseComplete("verify") (fired by write-verification)
				// flips phase_run.status to "completed" and reconcileSliceStatus
				// promotes the slice to "reviewing" (VERIFICATION.md exists), which
				// would fail write-pr's "verifying + verify started" precondition.
				writeArtifact(root, prRel, prMd);
				commitCommand(db, root, "write-pr", { sliceId: slice.id });

				// AC-21: write VERIFICATION.md + commit → projection flips
				// phase_run to completed.
				writeArtifact(root, vRel, vMd);
				commitCommand(db, root, "write-verification", { sliceId: slice.id });
			} else {
				// Overwrite artifacts on idempotent retry so the filesystem matches
				// what the subagent produced this run.
				writeArtifact(root, prRel, prMd);
				writeArtifact(root, vRel, vMd);
			}

			// AC-23: emit phase_complete
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_complete",
				phase: "verify",
			});
		});

		// --- Build subagent dispatch ---
		const prTemplate = readArtifact(root, "templates/pr-body.md");
		const mechanicalReport = readArtifact(
			root,
			`milestones/${mLabel}/slices/${sLabel}/VERIFICATION-MECHANICAL.md`,
		);

		const backtickRuns = [...diff.matchAll(/`+/g)].map((m) => m[0].length);
		const maxRun = backtickRuns.length > 0 ? Math.max(3, ...backtickRuns) : 3;
		const diffFence = "`".repeat(maxRun + 1);
		const artifacts: { label: string; content: string }[] = [
			{ label: "SPEC.md", content: specMd },
			{ label: "PLAN.md", content: planMd },
			{
				label: "Diff from milestone branch",
				content: `${diffFence}diff\n${diff}\n${diffFence}`,
			},
		];
		if (mechanicalReport) {
			artifacts.push({ label: "Mechanical verification report", content: mechanicalReport });
		}
		if (prTemplate) {
			artifacts.push({ label: "PR body template", content: prTemplate });
		}

		const compressLine = settings.compress.user_artifacts
			? "   - Write VERIFICATION.md in compressed R1-R10 notation."
			: "";

		const taskBody = buildVerifyTaskBody({ sLabel, wtPath, testInstruction, compressLine });

		const { message } = prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: slice.id,
			tasks: [{ agent: "tff-verifier", task: taskBody, cwd: wtPath, artifacts }],
		});

		return { success: true, retry: false, message };
	},
};
