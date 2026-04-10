import type Database from "better-sqlite3";
import { findActiveSlice } from "../orchestrator.js";

export interface AutoValidation {
	valid: boolean;
	sliceId?: string;
	error?: string;
}

export function validateAuto(db: Database.Database): AutoValidation {
	const slice = findActiveSlice(db);
	if (!slice) return { valid: false, error: "No active slice found" };
	return { valid: true, sliceId: slice.id };
}
