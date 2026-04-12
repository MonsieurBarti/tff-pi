import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { getMilestone, getSlice, resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { sliceLabel } from "../common/types.js";

export interface ShipChangesResult {
	success: boolean;
	message: string;
	feedback: string;
	milestoneNumber: number;
	sliceId: string;
}

/**
 * PR review requested changes. User runs this with the feedback text; we
 * flip the slice back to `executing`, reset tasks to open, and return the
 * feedback so the caller can re-enter execute with the context.
 *
 * Pairs with `/tff ship-merged` — together they replace the manual-review
 * polling loop where the user had to keep running `/tff ship <slice>` until
 * GitHub reported the merge state.
 */
export function handleShipChanges(
	pi: ExtensionAPI,
	db: Database.Database,
	sliceIdOrLabel: string,
	feedback: string,
): { success: false; message: string } | ShipChangesResult {
	const slice = getSlice(db, sliceIdOrLabel);
	if (!slice) {
		return { success: false, message: `Slice not found: ${sliceIdOrLabel}` };
	}
	if (slice.status === "closed") {
		return {
			success: false,
			message: `Slice ${sliceIdOrLabel} is already closed — cannot accept change requests.`,
		};
	}
	if (feedback.trim().length === 0) {
		return {
			success: false,
			message: "No feedback provided. Usage: /tff ship-changes <slice> <reviewer feedback text>",
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

	updateSliceStatus(db, slice.id, "executing");
	resetTasksToOpen(db, slice.id);

	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_failed",
		phase: "ship",
		durationMs: Date.now() - startTime,
		error: "PR review requested changes",
	});

	return {
		success: true,
		message: `${sLabel} reopened for fixes. Re-entering execute with feedback.`,
		feedback,
		milestoneNumber: milestone.number,
		sliceId: slice.id,
	};
}
