import { updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { sliceLabel } from "../common/types.js";
import {
	collectPhaseContext,
	loadPhaseResources,
	predecessorPhase,
	verifyPhaseArtifacts,
} from "../orchestrator.js";

export const planPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, slice, milestoneNumber, root, settings } = ctx;
		updateSliceStatus(db, slice.id, "planning");

		const sLabel = sliceLabel(milestoneNumber, slice.number);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "plan",
		});

		closePredecessorIfReady(pi, db, root, slice, "plan", predecessorPhase, verifyPhaseArtifacts);

		const { agentPrompt, protocol } = loadPhaseResources("plan");
		const context = collectPhaseContext(root, slice, milestoneNumber, "plan");

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

		pi.sendUserMessage(message);
		return { success: true, retry: false };
	},
};
