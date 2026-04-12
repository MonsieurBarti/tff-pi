import type Database from "better-sqlite3";
import type { Phase } from "../common/types.js";
import { determineNextPhase, findActiveSlice } from "../orchestrator.js";
import { assertPhasePreconditions } from "./phase-guard.js";

export interface NextValidation {
	valid: boolean;
	phase?: Phase;
	sliceId?: string;
	error?: string;
}

export function validateNext(
	db: Database.Database,
	projectRoot: string | null = null,
): NextValidation {
	const slice = findActiveSlice(db);
	if (!slice) return { valid: false, error: "No active slice found" };
	const phase = determineNextPhase(slice.status, slice.tier);
	if (!phase) return { valid: false, error: `No next phase available from '${slice.status}'` };
	const guard = assertPhasePreconditions(db, projectRoot, slice.id, phase);
	if (!guard.valid) return { valid: false, error: guard.error ?? "Previous phase incomplete" };
	return { valid: true, phase, sliceId: slice.id };
}
