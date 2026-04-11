import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { getMilestone, getSlice } from "../common/db.js";
import { isGateUnlocked } from "../common/discuss-gates.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export interface WriteSpecOptions {
	headless?: boolean;
}

export function handleWriteSpec(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
	options?: WriteSpecOptions,
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	if (
		options !== undefined &&
		options.headless !== true &&
		!isGateUnlocked(sliceId, "depth_verified")
	) {
		return {
			content: [
				{
					type: "text",
					text: "Depth verification required before writing SPEC.md. Complete the discuss phase first.",
				},
			],
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
	const path = `milestones/${mLabel}/slices/${label}/SPEC.md`;
	writeArtifact(root, path, content);
	return {
		content: [{ type: "text", text: `SPEC.md written for ${label}.` }],
		details: { sliceId, path },
	};
}

export function handleWriteRequirements(
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
	const path = `milestones/${mLabel}/slices/${label}/REQUIREMENTS.md`;
	writeArtifact(root, path, content);
	return {
		content: [{ type: "text", text: `REQUIREMENTS.md written for ${label}.` }],
		details: { sliceId, path },
	};
}
