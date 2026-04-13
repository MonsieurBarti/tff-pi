import type Database from "better-sqlite3";
import { getMilestone, getMilestones, getProject, getSlice, getSlices } from "./db.js";
import type { Milestone, Slice } from "./types.js";

/**
 * Pure, ctx-free resolvers from user-supplied refs (either `M<nn>`/`M<nn>-S<nn>`
 * labels or raw ids) to Milestone/Slice records. Kept separate from `context.ts`
 * so the session-scoped state module doesn't own label-lookup logic.
 */

/**
 * Look up a slice by its human-readable `M<nn>-S<nn>` label by traversing
 * project → milestones → slices. Returns null if the label is malformed or
 * no matching slice exists.
 */
export function findSliceByLabel(db: Database.Database, label: string): Slice | null {
	const match = label.match(/^M(\d+)-S(\d+)$/i);
	if (!match || !match[1] || !match[2]) return null;
	const mNum = Number.parseInt(match[1], 10);
	const sNum = Number.parseInt(match[2], 10);
	const project = getProject(db);
	if (!project) return null;
	const milestones = getMilestones(db, project.id);
	const milestone = milestones.find((m) => m.number === mNum);
	if (!milestone) return null;
	const slices = getSlices(db, milestone.id);
	return slices.find((s) => s.number === sNum) ?? null;
}

/**
 * Look up a milestone by its human-readable `M<nn>` label. Returns null if
 * the label is malformed or no matching milestone exists.
 */
export function findMilestoneByLabel(db: Database.Database, label: string): Milestone | null {
	const match = label.match(/^M(\d+)$/i);
	if (!match || !match[1]) return null;
	const mNum = Number.parseInt(match[1], 10);
	const project = getProject(db);
	if (!project) return null;
	const milestones = getMilestones(db, project.id);
	return milestones.find((m) => m.number === mNum) ?? null;
}

/**
 * Resolve a slice by user-supplied reference: tries label lookup first, then
 * falls back to treating the ref as a raw slice id.
 */
export function resolveSlice(db: Database.Database, ref: string): Slice | null {
	return findSliceByLabel(db, ref) ?? getSlice(db, ref);
}

/**
 * Resolve a milestone by user-supplied reference: tries label lookup first,
 * then falls back to treating the ref as a raw milestone id.
 */
export function resolveMilestone(db: Database.Database, ref: string): Milestone | null {
	return findMilestoneByLabel(db, ref) ?? getMilestone(db, ref);
}
