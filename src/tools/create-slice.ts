import type Database from "better-sqlite3";
import { initSliceDir } from "../common/artifacts.js";
import { getMilestone, getNextSliceNumber, insertSlice } from "../common/db.js";
import { sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleCreateSlice(
	db: Database.Database,
	root: string,
	milestoneId: string,
	title: string,
): ToolResult {
	const milestone = getMilestone(db, milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found: ${milestoneId}` }],
			details: { milestoneId },
			isError: true,
		};
	}
	const number = getNextSliceNumber(db, milestoneId);
	const sliceId = insertSlice(db, { milestoneId, number, title });
	initSliceDir(root, milestone.number, number);
	const label = sliceLabel(milestone.number, number);
	return {
		content: [{ type: "text", text: `Slice ${label} "${title}" created.` }],
		details: { sliceId, label, milestoneId, number },
	};
}
