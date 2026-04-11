import type Database from "better-sqlite3";
import type { Phase } from "../common/types.js";
import { determineNextPhase, findActiveSlice } from "../orchestrator.js";

export interface NextValidation {
	valid: boolean;
	phase?: Phase;
	sliceId?: string;
	error?: string;
}

export function validateNext(db: Database.Database): NextValidation {
	const slice = findActiveSlice(db);
	if (!slice) return { valid: false, error: "No active slice found" };
	const phase = determineNextPhase(slice.status, slice.tier);
	if (!phase) return { valid: false, error: `No next phase available from '${slice.status}'` };
	return { valid: true, phase, sliceId: slice.id };
}
