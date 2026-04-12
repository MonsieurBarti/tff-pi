import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { sliceLabel } from "../common/types.js";
import { finalizeMergedSlice, suggestNextAction } from "../phases/ship.js";

export interface ShipMergedResult {
	success: boolean;
	message: string;
}

/**
 * User-attested PR merge: runs the same cleanup as the MERGED re-entry branch
 * of `shipPhase` without consulting GitHub. This is the standard flow for
 * manual-review projects — once the user confirms the PR was merged, we reap
 * the worktree, delete slice branches, pull the milestone, and close the slice.
 *
 * We deliberately do NOT verify with `gh pr view` here: users want this to
 * work even when gh auth is scoped to their browser, and the attest-don't-
 * verify pattern matches TFF-CC's `AskUserQuestion` gate.
 */
export function handleShipMerged(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceIdOrLabel: string,
): ShipMergedResult {
	const slice = getSlice(db, sliceIdOrLabel);
	if (!slice) {
		return { success: false, message: `Slice not found: ${sliceIdOrLabel}` };
	}
	if (slice.status === "closed") {
		return {
			success: false,
			message: `Slice ${sliceIdOrLabel} is already closed.`,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			success: false,
			message: `Milestone not found for slice ${sliceIdOrLabel}.`,
		};
	}

	const sLabel = sliceLabel(milestone.number, slice.number);
	const startTime = Date.now();

	finalizeMergedSlice(db, root, slice, milestone.number);

	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_complete",
		phase: "ship",
		durationMs: Date.now() - startTime,
	});

	const next = suggestNextAction(db, slice.milestoneId);
	return {
		success: true,
		message: `${sLabel} closed. ${next}`,
	};
}
