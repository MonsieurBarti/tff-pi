import type Database from "better-sqlite3";
import {
	getDependencies,
	getMilestone,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	getTasks,
} from "../common/db.js";
import type { Dependency, Milestone, Project, Slice, Task } from "../common/types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface OverviewResult {
	project: Project | null;
	milestones: Milestone[];
}

export interface MilestoneResult {
	milestone: Milestone | null;
	slices: Slice[];
}

export interface SliceResult {
	slice: Slice | null;
	tasks: Task[];
	dependencies: Dependency[];
}

// ---------------------------------------------------------------------------
// Overloads
// ---------------------------------------------------------------------------

export function queryState(db: Database.Database, scope: "overview"): OverviewResult;
export function queryState(db: Database.Database, scope: "milestone", id: string): MilestoneResult;
export function queryState(db: Database.Database, scope: "slice", id: string): SliceResult;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function queryState(
	db: Database.Database,
	scope: "overview" | "milestone" | "slice",
	id?: string,
): OverviewResult | MilestoneResult | SliceResult {
	if (scope === "overview") {
		const project = getProject(db);
		const milestones = project ? getMilestones(db, project.id) : [];
		return { project, milestones };
	}

	if (scope === "milestone") {
		const milestone = id ? getMilestone(db, id) : null;
		const slices = milestone ? getSlices(db, milestone.id) : [];
		return { milestone, slices };
	}

	// scope === "slice"
	const slice = id ? getSlice(db, id) : null;
	const tasks = slice ? getTasks(db, slice.id) : [];
	const dependencies = slice ? getDependencies(db, slice.id) : [];
	return { slice, tasks, dependencies };
}
