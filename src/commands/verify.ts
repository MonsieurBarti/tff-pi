import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";

export function validateVerify(db: Database.Database, sliceId: string): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "executing" && slice.status !== "verifying") {
		return {
			valid: false,
			error: `Cannot verify: slice is in '${slice.status}' status (expected 'executing' or 'verifying')`,
		};
	}
	return { valid: true };
}
