import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";
import { assertPhasePreconditions } from "./phase-guard.js";

export function validateDiscuss(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "created" && slice.status !== "discussing") {
		return {
			valid: false,
			error: `Cannot start discuss: slice is in '${slice.status}' status (expected 'created' or 'discussing')`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "discuss");
}
