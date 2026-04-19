import { readArtifact } from "../common/artifacts.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { milestoneLabel, sanitizeForPrompt, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import { loadPhaseResources } from "../orchestrator.js";

/**
 * Ship-fix is a side-channel phase — it isn't part of the discuss→ship
 * pipeline. It shares the "shipping" slice-status (see recovery.ts) but emits
 * its own `phase: "ship-fix"` events so monitoring tools can distinguish it
 * from a real ship run on the same slice.
 */
export const shipFixPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, root, slice, milestoneNumber } = ctx;
		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const wtPath = getWorktreePath(root, sLabel);

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "ship-fix",
		});

		const feedbackRel = `milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`;
		const feedback = readArtifact(root, feedbackRel) ?? "";
		if (!feedback.trim()) {
			return {
				success: false,
				retry: false,
				error:
					"No REVIEW_FEEDBACK.md found. Run /tff ship-changes first to fetch reviewer comments.",
			};
		}

		const { agentPrompt, protocol } = loadPhaseResources("ship-fix");

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel} — "${sanitizeForPrompt(slice.title)}"`,
			"",
			`Worktree: ${wtPath}`,
			`Feedback artifact: .pi/.tff/${feedbackRel}`,
			"",
			"## Reviewer feedback",
			feedback,
			"",
			"Apply the smallest possible patch, discover and run the project's quality gates (see the protocol), then call tff_ask_user to ask the user whether to apply or reject. On approval, commit + push and call tff_ship_apply_done. On rejection, restore the worktree and call tff_ship_apply_done with rejected=true.",
		].join("\n");

		return { success: true, retry: false, message };
	},
};
