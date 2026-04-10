import { readArtifact } from "../common/artifacts.js";
import { getSlice, updateSliceStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { requestReview } from "../common/plannotator-review.js";
import { nextSliceStatus } from "../common/state-machine.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { buildPhasePrompt, collectPhaseContext, verifyPhaseArtifacts } from "../orchestrator.js";

const MAX_RETRIES = 2;

export const planPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "planning");

		const context = collectPhaseContext(root, slice, milestoneNumber, "plan");
		const prompt = buildPhasePrompt(
			slice,
			milestoneNumber,
			"plan",
			context,
			settings.compress.user_artifacts,
		);
		const agentResult = await dispatchSubAgent(pi, "planner", prompt);
		if (!agentResult.success) {
			return { success: false, retry: false, error: agentResult.output };
		}

		const verification = verifyPhaseArtifacts(db, root, slice, milestoneNumber, "plan");
		if (!verification.ok) {
			return {
				success: false,
				retry: false,
				error: `Phase artifacts missing: ${verification.missing.join(", ")}`,
			};
		}

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const artifactPath = `milestones/${mLabel}/slices/${sLabel}/PLAN.md`;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const content = readArtifact(root, artifactPath) ?? "";
			const gateResult = await requestReview(pi, artifactPath, content, "plan");
			if (gateResult.approved) {
				const current = getSlice(db, slice.id);
				if (current) {
					const next = nextSliceStatus(current.status, current.tier ?? undefined);
					if (next) updateSliceStatus(db, slice.id, next);
				}
				return { success: true, retry: false };
			}
			if (attempt < MAX_RETRIES) {
				const retryResult = await dispatchSubAgent(pi, "planner", prompt);
				if (!retryResult.success) break;
			}
		}
		return { success: false, retry: false, error: "Gate denied after retries" };
	},
};
