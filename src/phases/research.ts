import { getSlice, updateSliceStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { nextSliceStatus } from "../common/state-machine.js";
import { buildPhasePrompt, collectPhaseContext, verifyPhaseArtifacts } from "../orchestrator.js";

export const researchPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "researching");

		const context = collectPhaseContext(root, slice, milestoneNumber, "research");
		const prompt = buildPhasePrompt(
			slice,
			milestoneNumber,
			"research",
			context,
			settings.compress.user_artifacts,
		);
		const agentResult = await dispatchSubAgent(pi, "researcher", prompt);
		if (!agentResult.success) {
			return { success: false, retry: false, error: agentResult.output };
		}

		const verification = verifyPhaseArtifacts(db, root, slice, milestoneNumber, "research");
		if (!verification.ok) {
			return {
				success: false,
				retry: false,
				error: `Phase artifacts missing: ${verification.missing.join(", ")}`,
			};
		}

		const current = getSlice(db, slice.id);
		if (current) {
			const next = nextSliceStatus(current.status, current.tier ?? undefined);
			if (next) updateSliceStatus(db, slice.id, next);
		}
		return { success: true, retry: false };
	},
};
