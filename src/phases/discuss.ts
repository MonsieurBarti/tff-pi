import { updateSliceStatus } from "../common/db.js";
import { resetGates } from "../common/discuss-gates.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { type PreparationBrief, buildPreparationBrief } from "../common/preparation.js";
import { sliceLabel } from "../common/types.js";
import { loadPhaseResources } from "../orchestrator.js";

export const discussPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, slice, milestoneNumber } = ctx;

		updateSliceStatus(db, slice.id, "discussing");
		resetGates(slice.id);

		const sLabel = sliceLabel(milestoneNumber, slice.number);

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "discuss",
		});

		// Build preparation brief
		const brief = buildPreparationBrief(ctx.root, db, slice, milestoneNumber);

		// Load interactive resources
		const { agentPrompt, protocol } = loadPhaseResources("discuss");

		// Build the message to send to PI
		const briefSection = formatBrief(brief);
		const sliceContext = [
			`## Slice: ${sLabel} — "${slice.title}"`,
			`Slice ID: ${slice.id}`,
			`Tier: ${slice.tier ?? "unclassified"}`,
		].join("\n");

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			"## Preparation Brief",
			"",
			briefSection,
			"",
			"---",
			"",
			sliceContext,
		].join("\n");

		// Interactive mode does NOT emit phase_complete — completion is
		// tracked when `/tff next` verifies artifacts.
		// Message returned for delivery into fresh session.
		return { success: true, retry: false, message };
	},
};

function formatBrief(brief: PreparationBrief): string {
	const sections: string[] = [];

	if (brief.codebaseBrief) {
		sections.push(`### Codebase\n\n${brief.codebaseBrief}`);
	}
	if (brief.artifacts.project) {
		sections.push(`### PROJECT.md\n\n${brief.artifacts.project}`);
	}
	if (brief.artifacts.requirements) {
		sections.push(`### REQUIREMENTS.md\n\n${brief.artifacts.requirements}`);
	}
	if (brief.priorContext) {
		sections.push(`### Prior Context\n\n${brief.priorContext}`);
	}
	for (let i = 0; i < brief.artifacts.completedSpecs.length; i++) {
		sections.push(`### Completed Slice ${i + 1} Spec\n\n${brief.artifacts.completedSpecs[i]}`);
	}
	if (brief.relatedFiles) {
		sections.push(`### Related Files\n\n${brief.relatedFiles}`);
	}

	return sections.join("\n\n");
}
