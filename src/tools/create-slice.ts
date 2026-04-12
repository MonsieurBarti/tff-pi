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
		content: [
			{
				type: "text",
				text: `Slice ${label} "${title}" created (id: ${sliceId}). Use this ID or '${label}' in subsequent tool calls. To begin working on this slice, tell the user to run \`/tff discuss ${label}\` (or \`/tff next\` if it's the active slice). Do NOT suggest a non-existent command like /tff start — the valid phase subcommands are: discuss, research, plan, execute, verify, ship, next.`,
			},
		],
		details: { sliceId, label, milestoneId, number },
	};
}
