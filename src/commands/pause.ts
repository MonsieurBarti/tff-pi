import type Database from "better-sqlite3";
import { getSlice, updateSliceStatus } from "../common/db.js";
import { canTransitionSlice } from "../common/state-machine.js";

export interface PauseResult {
	success: boolean;
	error?: string;
}

export function handlePause(db: Database.Database, sliceId: string): PauseResult {
	const slice = getSlice(db, sliceId);
	if (!slice) return { success: false, error: `Slice not found: ${sliceId}` };
	if (!canTransitionSlice(slice.status, "paused")) {
		return {
			success: false,
			error: `Cannot pause slice in '${slice.status}' status`,
		};
	}
	updateSliceStatus(db, sliceId, "paused");
	return { success: true };
}
