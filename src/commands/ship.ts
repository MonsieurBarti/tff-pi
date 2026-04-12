import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";
import { assertPhasePreconditions } from "./phase-guard.js";

export function validateShip(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "reviewing" && slice.status !== "shipping") {
		return {
			valid: false,
			error: `Cannot ship: slice is in '${slice.status}' status (expected 'reviewing' or 'shipping')`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "ship");
}
