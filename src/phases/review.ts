import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readArtifact, writeArtifact } from "../common/artifacts.js";
import { milestoneBranchName, sliceBranchName } from "../common/branch-naming.js";
import { commitCommand } from "../common/commit.js";
import { getLatestPhaseRun, getMilestone } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import {
	type FinalizeInput,
	prepareDispatch,
	registerPhaseFinalizer,
} from "../common/subagent-dispatcher.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import { loadAgentResource, predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

const VERDICT_RE = /^VERDICT:\s*(approved|denied)\s*$/gm;

function buildReviewTaskBody(p: {
	sLabel: string;
	wtPath: string;
	milestoneBranch: string;
	sliceBranch: string;
	compressLine: string;
}): string {
	const lines = [
		`Slice: ${p.sLabel}`,
		"",
		`Working directory: ${p.wtPath}`,
		`Milestone branch: ${p.milestoneBranch}`,
		`Slice branch:     ${p.sliceBranch}`,
		"",
		`Read-only except for a single write to ${p.wtPath}/.pi/.tff/artifacts/REVIEW.md.`,
		"",
		"1. Inspect the diff yourself:",
		`   - \`git -C ${p.wtPath} diff --stat ${p.milestoneBranch}...${p.sliceBranch}\` (file footprint)`,
		`   - \`git -C ${p.wtPath} diff ${p.milestoneBranch}...${p.sliceBranch}\` (full diff)`,
		`   - \`git -C ${p.wtPath} diff ${p.milestoneBranch}...${p.sliceBranch} -- <path>\` (scope)`,
		"",
		"2. Code review lens — for every AC in SPEC.md and every task in PLAN.md, check the diff.",
		"   Classify findings: Critical (blocks merge) / Important (should fix) / Suggestion (optional).",
		"   Every finding cites file:line.",
		"",
		"3. Security review lens — audit the same diff per the Security-lens reference above.",
		"   Cite file:line + severity (Critical / High / Medium / Low / Info).",
		"",
		`4. Write ${p.wtPath}/.pi/.tff/artifacts/REVIEW.md containing:`,
		"   - Summary (one paragraph)",
		"   - Code Review findings (table or list; file, line, severity, message)",
		"   - Security Review findings (table or list; same columns)",
		"   - Tasks to rework (PLAN.md task refs if VERDICT = denied; omit if approved)",
		"   - A trailing line: `VERDICT: approved` OR `VERDICT: denied`",
	];
	if (p.compressLine.length > 0) lines.push(p.compressLine);
	lines.push(
		"",
		"5. End with:",
		"   STATUS: <DONE|DONE_WITH_CONCERNS|BLOCKED>",
		"   EVIDENCE: <one-line summary>",
		"",
		"`bash` is allowlisted for `git diff` inspection only. Do NOT run mutation commands, network commands, or write outside <cwd>/.pi/.tff/artifacts/.",
	);
	return lines.join("\n");
}

export const reviewPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "review",
		});

		closePredecessorIfReady(pi, db, root, slice, "review", predecessorPhase, verifyPhaseArtifacts);

		const wtPath = getWorktreePath(root, sLabel);
		const sliceRel = `milestones/${mLabel}/slices/${sLabel}`;
		const specMd = readArtifact(root, `${sliceRel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `${sliceRel}/PLAN.md`) ?? "";
		const verifyMd = readArtifact(root, `${sliceRel}/VERIFICATION.md`) ?? "";
		const securityLensFull = loadAgentResource("tff-security-auditor");
		// Strip YAML front-matter (between the first two "---" lines) to pass only body.
		const securityLensBody = securityLensFull.replace(/^---[\s\S]*?^---\s*/m, "").trim();

		const milestoneRow = getMilestone(db, slice.milestoneId);
		if (!milestoneRow) {
			return { success: false, retry: false, error: `Milestone not found: ${slice.milestoneId}` };
		}
		const milestoneBranch = milestoneBranchName(milestoneRow);
		const sliceBranch = sliceBranchName(slice);

		// --- Register review finalizer (captures {db, pi, root, slice,
		// milestoneNumber, wtPath, mLabel, sLabel} by ref) ---
		registerPhaseFinalizer("review", async ({ result }: FinalizeInput) => {
			const r = result.results[0];

			// AC-10: BLOCKED / malformed
			if (!r || r.status === "BLOCKED" || r.status === "NEEDS_CONTEXT") {
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "review",
					error: r?.evidence ?? "BLOCKED",
				});
				return;
			}

			const reviewSrc = join(wtPath, ".pi", ".tff", "artifacts", "REVIEW.md");

			// AC-11: missing artifact
			if (!existsSync(reviewSrc)) {
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "review",
					error: "missing REVIEW.md",
				});
				return;
			}

			// AC-12: symlink rejection
			if (lstatSync(reviewSrc).isSymbolicLink()) {
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "review",
					error: `symlink rejected: ${basename(reviewSrc)}`,
				});
				return;
			}

			const reviewMd = readFileSync(reviewSrc, "utf-8");

			// AC-13: VERDICT parse — take the LAST matching line (spec: "a
			// trailing line: VERDICT: approved OR VERDICT: denied"). Using the
			// last occurrence prevents earlier prose that happens to contain a
			// `VERDICT:` line from swallowing the true trailer.
			const verdictMatches = [...reviewMd.matchAll(VERDICT_RE)];
			const verdictMatch = verdictMatches.at(-1);
			if (!verdictMatch) {
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "review",
					error: "missing or malformed VERDICT",
				});
				return;
			}
			const verdict = verdictMatch[1] as "approved" | "denied";
			const reviewRel = `${sliceRel}/REVIEW.md`;

			// AC-14: denied
			if (verdict === "denied") {
				writeArtifact(root, reviewRel, reviewMd);
				commitCommand(db, root, "review-rejected", { sliceId: slice.id });
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "review",
					error: "Review verdict: denied",
				});
				return;
			}

			// AC-15, 16, 17, 18: approved path with idempotency guard.
			const latestRun = getLatestPhaseRun(db, slice.id, "review");
			const alreadyCompleted = latestRun?.status === "completed";

			writeArtifact(root, reviewRel, reviewMd);
			if (!alreadyCompleted) {
				commitCommand(db, root, "write-review", { sliceId: slice.id });
			}

			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_complete",
				phase: "review",
			});
		});

		// --- Build dispatch ---
		const artifacts: { label: string; content: string }[] = [
			{ label: "SPEC.md", content: specMd },
			{ label: "PLAN.md", content: planMd },
			{ label: "VERIFICATION.md", content: verifyMd },
			{ label: "Security-lens reference", content: securityLensBody },
		];

		const compressLine = settings.compress.user_artifacts
			? "   Write the body of REVIEW.md in compressed R1-R10 notation. The final `VERDICT: <approved|denied>` line MUST remain uncompressed — exact wording, no substitutions."
			: "";

		const taskBody = buildReviewTaskBody({
			sLabel,
			wtPath,
			milestoneBranch,
			sliceBranch,
			compressLine,
		});

		const { message } = prepareDispatch(root, {
			mode: "single",
			phase: "review",
			sliceId: slice.id,
			tasks: [{ agent: "tff-code-reviewer", task: taskBody, cwd: wtPath, artifacts }],
		});

		return { success: true, retry: false, message };
	},
};
