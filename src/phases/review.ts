import { readArtifact } from "../common/artifacts.js";
import { updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getDiff } from "../common/git.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import { loadAgentResource, loadPhaseResources } from "../orchestrator.js";

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
		const diff = getDiff(milestoneBranch, wtPath) ?? "";

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel}`,
			`Working directory: ${wtPath}`,
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
			"## Diff from milestone branch",
			"```diff",
			diff,
			"```",
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
