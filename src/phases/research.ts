import { getSlice, updateSliceStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { nextSliceStatus } from "../common/state-machine.js";
import { sliceLabel } from "../common/types.js";
import { buildPhasePrompt, collectPhaseContext, verifyPhaseArtifacts } from "../orchestrator.js";

export const researchPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "researching");

		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const startTime = Date.now();
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "research",
		});

		const context = collectPhaseContext(root, slice, milestoneNumber, "research");
		const prompt = buildPhasePrompt(
			slice,
			milestoneNumber,
			"research",
			context,
			settings.compress.user_artifacts,
		);
		const agentResult = await dispatchSubAgent(
			pi,
			"researcher",
			prompt,
			undefined,
			ctx.onSubAgentActivity,
		);
		if (!agentResult.success) {
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "research",
				durationMs: Date.now() - startTime,
				error: agentResult.output,
			});
			return { success: false, retry: false, error: agentResult.output };
		}

		const verification = verifyPhaseArtifacts(db, root, slice, milestoneNumber, "research");
		if (!verification.ok) {
			const error = `Phase artifacts missing: ${verification.missing.join(", ")}`;
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "research",
				durationMs: Date.now() - startTime,
				error,
			});
			return {
				success: false,
				retry: false,
				error,
			};
		}

		const current = getSlice(db, slice.id);
		if (current) {
			const next = nextSliceStatus(current.status, current.tier ?? undefined);
			if (next) updateSliceStatus(db, slice.id, next);
		}
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_complete",
			phase: "research",
			durationMs: Date.now() - startTime,
		});
		return { success: true, retry: false };
	},
};
