import type Database from "better-sqlite3";
import { getSlice, updateSliceTier } from "../common/db.js";
import type { Tier } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleClassify(db: Database.Database, sliceId: string, tier: Tier): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	updateSliceTier(db, sliceId, tier);

	return {
		content: [
			{
				type: "text",
				text: `Slice ${sliceId} classified as Tier ${tier}`,
			},
		],
		details: { sliceId, tier },
	};
}
