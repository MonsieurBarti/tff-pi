import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifact } from "../common/artifacts.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import type { Phase } from "../common/types.js";
import { milestoneLabel, sanitizeForPrompt, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";

/**
 * Ship-fix is a side-channel phase — it isn't part of the discuss→ship
 * pipeline (no status transitions, no predecessor). Rather than extend the
 * `Phase` union (which would ripple through routing, recovery, and tooling),
 * we reuse the "ship" phase slot in events and load resources directly.
 */
const SHIP_FIX_PHASE = "ship" as Phase;

const RESOURCES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "resources");

function loadResource(relPath: string): string {
	try {
		return readFileSync(join(RESOURCES_DIR, relPath), "utf-8");
	} catch {
		return "";
	}
}

export const shipFixPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, root, slice, milestoneNumber } = ctx;
		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const wtPath = getWorktreePath(root, sLabel);

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: SHIP_FIX_PHASE,
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

		const agentPrompt = loadResource("agents/inline-fixer.md");
		const protocol = loadResource("protocols/ship-fix.md");

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel} — "${sanitizeForPrompt(slice.title)}"`,
			"",
			`Worktree: ${wtPath}`,
			`Feedback artifact: .tff/${feedbackRel}`,
			"",
			"## Reviewer feedback",
			feedback,
			"",
			"Apply the smallest possible patch, run all quality gates (bun run lint:fix → typecheck → test → build), then call tff_ask_user to ask the user whether to apply or reject. On approval, commit + push and call tff_ship_apply_done. On rejection, restore the worktree and call tff_ship_apply_done with rejected=true.",
		].join("\n");

		return { success: true, retry: false, message };
	},
};
