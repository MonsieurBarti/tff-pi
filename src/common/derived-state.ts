import type Database from "better-sqlite3";
import { readArtifact } from "./artifacts.js";
import { getMilestone, getSlice } from "./db.js";
import { type SliceStatus, milestoneLabel, sliceLabel } from "./types.js";

export function computeSliceStatus(
	db: Database.Database,
	root: string,
	sliceId: string,
): SliceStatus {
	const slice = getSlice(db, sliceId);
	if (!slice) return "created";

	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return "created";

	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);
	const base = `milestones/${mLabel}/slices/${sLabel}`;

	// Rule 7 only for now. Other rules added in subsequent tasks.
	const hasSpec = readArtifact(root, `${base}/SPEC.md`) !== null;
	const hasRequirements = readArtifact(root, `${base}/REQUIREMENTS.md`) !== null;
	if (hasSpec || hasRequirements) return "discussing";

	return "created";
}
