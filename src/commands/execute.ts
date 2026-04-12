import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";
import { assertPhasePreconditions } from "./phase-guard.js";

export function validateExecute(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "planning" && slice.status !== "executing") {
		return {
			valid: false,
			error: `Cannot execute: slice is in '${slice.status}' status (expected 'planning' or 'executing')`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "execute");
}
