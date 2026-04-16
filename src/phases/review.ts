import { readArtifact } from "../common/artifacts.js";
import { milestoneBranchName, sliceBranchName } from "../common/branch-naming.js";
import { getMilestone } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import {
	loadAgentResource,
	loadPhaseResources,
	predecessorPhase,
	verifyPhaseArtifacts,
} from "../orchestrator.js";

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
		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
		const verifyMd =
			readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`) ?? "";

		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite all feedback in compressed R1-R10 notation."
			: "";

		const { agentPrompt, protocol } = loadPhaseResources("review");
		const securityReviewerPrompt = loadAgentResource("security-reviewer");
		const milestoneRow = getMilestone(db, slice.milestoneId);
		if (!milestoneRow) {
			return { success: false, retry: false, error: `Milestone not found: ${slice.milestoneId}` };
		}
		const milestoneBranch = milestoneBranchName(milestoneRow);
		const sliceBranch = sliceBranchName(slice);

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel}`,
			`Working directory: ${wtPath}`,
			`Milestone: ${mLabel} (branch: ${milestoneBranch})`,
			`Slice: ${sLabel} (branch: ${sliceBranch})`,
			"",
			"## SPEC.md",
			specMd,
			"",
			"## PLAN.md",
			planMd,
			"",
			"## VERIFICATION.md",
			verifyMd,
			"",
			"## Diff",
			"Inspect the diff yourself using git. The full diff is NOT inlined to keep your context focused.",
			"",
			"```bash",
			"# overview of changed files",
			`git -C ${wtPath} diff --stat ${milestoneBranch}...${sliceBranch}`,
			"",
			"# full diff",
			`git -C ${wtPath} diff ${milestoneBranch}...${sliceBranch}`,
			"",
			"# scope to one file",
			`git -C ${wtPath} diff ${milestoneBranch}...${sliceBranch} -- <path>`,
			"```",
			"",
			"Prefer `--stat` first to plan your reads, then diff specific files as needed.",
			"",
			"---",
			"",
			"## Security Review",
			securityReviewerPrompt,
			"",
			"After completing the code review above, perform a security-focused review pass on the same diff using the security reviewer guidelines above.",
			compressHint,
		].join("\n");

		return { success: true, retry: false, message };
	},
};
