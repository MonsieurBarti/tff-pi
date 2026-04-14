import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import {
	collectPhaseContext,
	loadPhaseResources,
	predecessorPhase,
	verifyPhaseArtifacts,
} from "../orchestrator.js";

export const planPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, slice, milestoneNumber, root, settings } = ctx;

		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const mLabel = milestoneLabel(milestoneNumber);
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

		// Best-effort: enrich with related files discovered via fff bridge.
		let relatedFiles = "";
		if (ctx.fffBridge) {
			try {
				const sliceWords = slice.title
					.split(/\s+/)
					.filter((w) => w.length > 3)
					.slice(0, 5);
				if (sliceWords.length > 0) {
					const grepResults = await ctx.fffBridge.grep(sliceWords, { maxResults: 10 });
					if (grepResults.length > 0) {
						relatedFiles = grepResults.map((r) => r.path).join("\n");
					}
				}
			} catch {
				// best-effort — don't fail the phase
			}
		}

		const artifactBase = `.tff/milestones/${mLabel}/slices/${sLabel}/`;
		const pathHint = [
			"",
			`**Slice artifact path:** \`${artifactBase}\``,
			"SPEC.md, PLAN.md, REQUIREMENTS.md, and other slice artifacts live under this directory. Do not look for them at project root.",
			"",
		].join("\n");

		const messageParts = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel} — "${slice.title}"`,
			`Slice ID: ${slice.id}`,
			`Tier: ${slice.tier ?? "unclassified"}`,
			pathHint,
			"## Context",
			"",
			contextBlock,
		];

		if (relatedFiles) {
			messageParts.push("", "## Related Files", "", relatedFiles);
		}

		messageParts.push(compressHint);
		const message = messageParts.join("\n");

		return { success: true, retry: false, message };
	},
};
