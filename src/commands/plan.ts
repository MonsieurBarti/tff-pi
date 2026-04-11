import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";

export function validatePlan(db: Database.Database, sliceId: string): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status === "researching" || slice.status === "planning") {
		return { valid: true };
	}
	if (slice.status === "discussing" && slice.tier === "S") {
		return { valid: true };
	}
	return {
		valid: false,
		error: `Cannot start plan: slice is in '${slice.status}' status${slice.tier !== "S" ? " (non-S-tier must complete research first)" : ""}`,
	};
}
