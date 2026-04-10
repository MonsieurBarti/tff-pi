import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";

export interface ValidateResult {
	valid: boolean;
	error?: string;
}

export function validateExecute(db: Database.Database, sliceId: string): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "planning") {
		return {
			valid: false,
			error: `Cannot execute: slice is in '${slice.status}' status (expected 'planning')`,
		};
	}
	return { valid: true };
}
