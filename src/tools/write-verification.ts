import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { getMilestone, getSlice } from "../common/db.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleWriteVerification(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
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
	const path = `milestones/${mLabel}/slices/${label}/VERIFICATION.md`;
	writeArtifact(root, path, content);
	return {
		content: [{ type: "text", text: `VERIFICATION.md written for ${label}.` }],
		details: { sliceId, path },
	};
}
