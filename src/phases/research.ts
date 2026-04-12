import { updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { sliceLabel } from "../common/types.js";
import { collectPhaseContext, loadPhaseResources } from "../orchestrator.js";

export const researchPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, slice, milestoneNumber, root, settings } = ctx;
		updateSliceStatus(db, slice.id, "researching");

		const sLabel = sliceLabel(milestoneNumber, slice.number);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "research",
		});

		const { agentPrompt, protocol } = loadPhaseResources("research");
		const context = collectPhaseContext(root, slice, milestoneNumber, "research");

		const contextBlock = Object.entries(context)
			.map(([name, content]) => `### ${name}\n\n${content}`)
			.join("\n\n");

		const compressHint = settings.compress.user_artifacts
			? "\n\n**IMPORTANT:** Write all artifact content in compressed R1-R10 notation."
			: "";

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel} — "${slice.title}"`,
			`Slice ID: ${slice.id}`,
			`Tier: ${slice.tier ?? "unclassified"}`,
			"",
			"## Context",
			"",
			contextBlock,
			compressHint,
		].join("\n");

		return { success: true, retry: false, message };
	},
};
