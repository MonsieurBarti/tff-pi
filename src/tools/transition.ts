import type Database from "better-sqlite3";
import { getSlice, updateSliceStatus } from "../common/db.js";
import { SLICE_TRANSITIONS, canTransitionSlice, nextSliceStatus } from "../common/state-machine.js";
import { SLICE_STATUSES, type SliceStatus } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleTransition(
	db: Database.Database,
	sliceId: string,
	targetStatus?: string,
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	if (targetStatus && !(SLICE_STATUSES as readonly string[]).includes(targetStatus)) {
		return {
			content: [
				{
					type: "text",
					text: `Invalid status: ${targetStatus}. Valid: ${SLICE_STATUSES.join(", ")}`,
				},
			],
			details: { sliceId, targetStatus },
			isError: true,
		};
	}

	const target = targetStatus
		? (targetStatus as SliceStatus)
		: nextSliceStatus(slice.status, slice.tier ?? undefined);

	if (!target) {
		return {
			content: [{ type: "text", text: `No valid next status from '${slice.status}'.` }],
			details: { sliceId, currentStatus: slice.status },
			isError: true,
		};
	}

	if (!canTransitionSlice(slice.status, target)) {
		return {
			content: [
				{
					type: "text",
					text: `Invalid transition: '${slice.status}' → '${target}'. Allowed from '${slice.status}': ${SLICE_TRANSITIONS[slice.status].join(", ")}`,
				},
			],
			details: { sliceId, from: slice.status, to: target },
			isError: true,
		};
	}

	updateSliceStatus(db, sliceId, target);

	return {
		content: [
			{
				type: "text",
				text: `Slice ${sliceId} transitioned: ${slice.status} → ${target}`,
			},
		],
		details: { sliceId, from: slice.status, to: target },
	};
}
