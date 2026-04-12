import { readArtifact } from "../common/artifacts.js";
import { updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import {
	loadAgentResource,
	loadPhaseResources,
	predecessorPhase,
	verifyPhaseArtifacts,
} from "../orchestrator.js";

export const reviewPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "reviewing");

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
		const milestoneBranch = `milestone/${mLabel}`;
		const sliceBranch = `slice/${sLabel}`;

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel}`,
			`Working directory: ${wtPath}`,
			`Milestone branch: ${milestoneBranch}`,
			`Slice branch: ${sliceBranch}`,
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

		pi.sendUserMessage(message);
		return { success: true, retry: false };
	},
};
