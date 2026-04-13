import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb, resolveMilestone, resolveSlice } from "../common/context.js";
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

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_query_state",
			label: "TFF Query State",
			description:
				"Query the current TFF project state. Use scope=overview for project + milestones, scope=milestone with an id for slices, or scope=slice with an id for tasks and dependencies.",
			parameters: Type.Object({
				scope: StringEnum(["overview", "milestone", "slice"] as const, {
					description: "What to query: overview, a specific milestone, or a specific slice",
				}),
				id: Type.Optional(
					Type.String({
						description:
							"Milestone ID (UUID) or label (e.g., M01) for scope=milestone; slice ID (UUID) or label (e.g., M01-S01) for scope=slice",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					let result: unknown;
					if (params.scope === "overview") {
						result = queryState(database, "overview");
					} else if (params.scope === "milestone") {
						const milestone = params.id ? resolveMilestone(database, params.id) : null;
						result = queryState(database, "milestone", milestone?.id ?? params.id ?? "");
					} else {
						const slice = params.id ? resolveSlice(database, params.id) : null;
						result = queryState(database, "slice", slice?.id ?? params.id ?? "");
					}
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: { scope: params.scope, id: params.id },
					};
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { scope: params.scope, id: params.id },
						isError: true,
					};
				}
			},
		}),
	);
}
