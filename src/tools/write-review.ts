import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { getMilestone, getSlice, resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export type ReviewVerdict = "approved" | "denied";

/**
 * Writes REVIEW.md and, on 'denied' verdict, routes the slice back to
 * execute (resetting the listed tasks to 'open') so the agent can rework
 * the flagged issues. On 'approved' the slice stays in 'reviewing' and the
 * user can advance to ship via /tff next.
 */
export function handleWriteReview(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
	verdict: ReviewVerdict,
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found for slice: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const label = sliceLabel(milestone.number, slice.number);
	const mLabel = milestoneLabel(milestone.number);
	const path = `milestones/${mLabel}/slices/${label}/REVIEW.md`;
	writeArtifact(root, path, content);

	if (verdict === "denied") {
		resetTasksToOpen(db, sliceId);
		updateSliceStatus(db, sliceId, "executing");
		return {
			content: [
				{
					type: "text",
					text: `REVIEW.md written for ${label} (denied). Tasks reset to open; slice routed back to execute. Address the findings in REVIEW.md and re-run execute.`,
				},
			],
			details: { sliceId, path, verdict, routedTo: "executing" },
		};
	}

	return {
		content: [
			{
				type: "text",
				text: `REVIEW.md written for ${label} (approved). Run /tff next to proceed to ship.`,
			},
		],
		details: { sliceId, path, verdict },
	};
}
