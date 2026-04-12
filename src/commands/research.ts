import type Database from "better-sqlite3";
import { getSlice } from "../common/db.js";
import type { ValidateResult } from "../common/types.js";
import { assertPhasePreconditions } from "./phase-guard.js";

export function validateResearch(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "discussing" && slice.status !== "researching") {
		return {
			valid: false,
			error: `Cannot start research: slice is in '${slice.status}' status (expected 'discussing' or 'researching')`,
		};
	}
	if (slice.tier === "S") {
		return {
			valid: false,
			error: "Cannot research an S-tier slice — skip directly to plan",
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "research");
}
