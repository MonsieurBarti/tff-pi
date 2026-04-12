import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";
import { assertPhasePreconditions } from "./phase-guard.js";

export function validatePlan(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	const statusOk =
		slice.status === "researching" ||
		slice.status === "planning" ||
		(slice.status === "discussing" && slice.tier === "S");
	if (!statusOk) {
		return {
			valid: false,
			error: `Cannot start plan: slice is in '${slice.status}' status${slice.tier !== "S" ? " (non-S-tier must complete research first)" : ""}`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "plan");
}
