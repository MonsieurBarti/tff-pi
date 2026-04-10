import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";

export interface ValidateResult {
	valid: boolean;
	error?: string;
}

export function validatePlan(db: Database.Database, sliceId: string): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "discussing" && slice.status !== "researching") {
		return {
			valid: false,
			error: `Cannot start plan: slice is in '${slice.status}' status (expected 'discussing' or 'researching')`,
		};
	}
	return { valid: true };
}
