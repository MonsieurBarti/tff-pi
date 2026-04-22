import { readArtifact, writeArtifact } from "../common/artifacts.js";
import { milestoneBranchName } from "../common/branch-naming.js";
import { createCheckpoint } from "../common/checkpoint.js";
import { compressIfEnabled } from "../common/compress.js";
import { getMilestone, resetTasksToOpen } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getDiff } from "../common/git.js";
import {
	formatMechanicalReport,
	runMechanicalVerification,
} from "../common/mechanical-verifier.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import { ensurePhaseTransition } from "../common/phase-entry.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { prepareDispatch } from "../common/subagent-dispatcher.js";
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

		ensurePhaseTransition(db, root, slice, "verify");

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

		// Finalizer registered once at extension init (see src/phases/finalizers.ts
		// + lifecycle.ts). Stateless: reconstructs everything from config.sliceId
		// + DB + disk so it can run in any session that handles the subagent
		// tool_result — PI's newSession() isolates module state.

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

		// Parallel mode with one task: avoids pi-subagents' single-mode
		// agent-discovery bug where top-level cwd collapses findNearestProjectRoot
		// into the worktree's own .pi/ (no .pi/agents/ there) and returns
		// "Unknown agent: tff-verifier". Parallel mode uses per-task cwd; agent
		// discovery falls back to ctx.cwd (parent session / repo root) and finds
		// the project-scope tff-verifier in <repo>/.pi/agents/.
		const { message } = prepareDispatch(root, {
			mode: "parallel",
			phase: "verify",
			sliceId: slice.id,
			tasks: [{ agent: "tff-verifier", task: taskBody, cwd: wtPath, artifacts }],
		});

		return { success: true, retry: false, message };
	},
};
