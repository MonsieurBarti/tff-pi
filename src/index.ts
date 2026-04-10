import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { validateAuto } from "./commands/auto.js";
import { validateDiscuss } from "./commands/discuss.js";
import { handleHealth } from "./commands/health.js";
import { createMilestone } from "./commands/new-milestone.js";
import { validateNext } from "./commands/next.js";
import { handlePause } from "./commands/pause.js";
import { validatePlan } from "./commands/plan.js";
import { handleProgress } from "./commands/progress.js";
import { validateResearch } from "./commands/research.js";
import { handleStatus } from "./commands/status.js";
import { initTffDirectory, readArtifact, tffPath } from "./common/artifacts.js";
import { applyMigrations, getMilestone, getProject, getSlice, openDatabase } from "./common/db.js";
import { getGitRoot } from "./common/git.js";
import type { PhaseContext } from "./common/phase.js";
import { isValidSubcommand, parseSubcommand } from "./common/router.js";
import { DEFAULT_SETTINGS, type Settings, parseSettings } from "./common/settings.js";
import { SLICE_STATUSES, TIERS, milestoneLabel } from "./common/types.js";
import { determineNextPhase, findActiveSlice } from "./orchestrator.js";
import { phaseModules } from "./phases/index.js";
import { handleClassify } from "./tools/classify.js";
import { handleCreateProject } from "./tools/create-project.js";
import { handleCreateSlice } from "./tools/create-slice.js";
import { queryState } from "./tools/query-state.js";
import { handleTransition } from "./tools/transition.js";
import { type TaskInput, handleWritePlan } from "./tools/write-plan.js";
import { handleWriteResearch } from "./tools/write-research.js";
import { handleWriteSpec } from "./tools/write-spec.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let projectRoot: string | null = null;
let settings: Settings | null = null;
let initError: string | null = null;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function getDb(): Database.Database {
	if (!db) {
		throw new Error("TFF database not initialized. Run `/tff new` to set up the project.");
	}
	return db;
}

function initDb(root: string): void {
	initTffDirectory(root);
	const dbPath = tffPath(root, "state.db");
	db = openDatabase(dbPath);
	applyMigrations(db);
}

function loadSettings(root: string): void {
	const yaml = readArtifact(root, "settings.yaml");
	settings = yaml
		? parseSettings(yaml)
		: { ...DEFAULT_SETTINGS, compress: { ...DEFAULT_SETTINGS.compress } };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function tffExtension(pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// Lifecycle: session_start
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const root = getGitRoot();
		if (!root) {
			return;
		}
		projectRoot = root;

		const dbPath = tffPath(root, "state.db");
		if (existsSync(join(root, ".tff")) && existsSync(dbPath)) {
			try {
				db = openDatabase(dbPath);
				applyMigrations(db);
				loadSettings(root);
				initError = null;
				if (ctx.hasUI) {
					ctx.ui.notify("TFF ready", "info");
				}
			} catch (err) {
				initError = err instanceof Error ? err.message : String(err);
			}
		}
	});

	// -------------------------------------------------------------------------
	// Lifecycle: session_shutdown
	// -------------------------------------------------------------------------
	pi.on("session_shutdown", async () => {
		if (db) {
			db.close();
			db = null;
		}
	});

	// -------------------------------------------------------------------------
	// /tff command
	// -------------------------------------------------------------------------
	pi.registerCommand("tff", {
		description:
			"The Forge Flow — project workflow manager. Subcommands: new, status, progress, health, settings, help (and more)",
		handler: async (args, ctx) => {
			const { subcommand, args: rest } = parseSubcommand(args);

			if (!isValidSubcommand(subcommand)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Unknown subcommand: ${subcommand}. Run \`/tff help\` for usage.`, "error");
				}
				return;
			}

			switch (subcommand) {
				case "new": {
					const root = getGitRoot() ?? projectRoot;
					if (!root) {
						if (ctx.hasUI) ctx.ui.notify("Not inside a git repository.", "error");
						return;
					}
					projectRoot = root;
					initDb(root);
					loadSettings(root);

					const projectName = rest[0] ?? "New Project";
					pi.sendUserMessage(
						`You are setting up a new TFF project. The user wants to create a project called "${projectName}".\n\nPlease help them brainstorm:\n1. A clear vision statement for the project\n\nOnce agreed, call the tff_create_project tool with the project name and vision. After creating the project, suggest the user run /tff new-milestone.`,
					);
					break;
				}

				case "help": {
					pi.sendUserMessage(
						"Here are the available TFF commands:\n\n" +
							"**Project setup:**\n" +
							"- `/tff new [name]` — Start a new project (AI-assisted brainstorm)\n" +
							"- `/tff new-milestone [name]` — Create a new milestone\n\n" +
							"**Slice workflow:**\n" +
							"- `/tff discuss [sliceId]` — Run the discuss phase on a slice\n" +
							"- `/tff research [sliceId]` — Run the research phase on a slice\n" +
							"- `/tff plan [sliceId]` — Run the plan phase on a slice\n" +
							"- `/tff next` — Advance the active slice to its next phase\n" +
							"- `/tff auto` — Automatically advance slices through phases\n" +
							"- `/tff pause [sliceId]` — Pause the active slice\n\n" +
							"**Monitoring:**\n" +
							"- `/tff status` — Show current project status\n" +
							"- `/tff progress` — Show detailed progress table\n" +
							"- `/tff health` — Quick database health check\n" +
							"- `/tff settings` — Show current settings\n" +
							"- `/tff help` — Show this help\n\n" +
							"Not yet implemented: execute, verify, ship, complete-milestone, rollback",
					);
					break;
				}

				case "status": {
					const result = handleStatus(getDb());
					pi.sendUserMessage(result);
					break;
				}

				case "progress": {
					const result = handleProgress(getDb());
					pi.sendUserMessage(result);
					break;
				}

				case "health": {
					let msg: string;
					try {
						const database = getDb();
						msg = handleHealth(database);
					} catch (err) {
						msg = `TFF health: NOT OK — ${err instanceof Error ? err.message : String(err)}`;
					}
					if (initError) {
						msg += `\n- Init warning: ${initError}`;
					}
					if (ctx.hasUI) {
						ctx.ui.notify(msg, "info");
					}
					pi.sendUserMessage(msg);
					break;
				}

				case "settings": {
					const current = settings ?? DEFAULT_SETTINGS;
					pi.sendUserMessage(
						`Current TFF settings:\n\n- model_profile: ${current.model_profile}\n- compress.user_artifacts: ${current.compress.user_artifacts}\n\nTo change settings, edit \`.tff/settings.yaml\` in your project root.`,
					);
					break;
				}

				case "new-milestone": {
					const database = getDb();
					const root = projectRoot;
					if (!root) {
						if (ctx.hasUI) ctx.ui.notify("Not inside a git repository.", "error");
						return;
					}
					const project = getProject(database);
					if (!project) {
						if (ctx.hasUI) ctx.ui.notify("No project found. Run /tff new first.", "error");
						return;
					}
					const milestoneName = rest[0] ?? "New Milestone";
					const result = createMilestone(database, root, project.id, milestoneName);
					pi.sendUserMessage(
						`Milestone ${milestoneLabel(result.number)} "${milestoneName}" created on branch ${result.branch}.\n\nNow brainstorm requirements and decompose into slices. Use the tff_create_slice tool to create each slice.`,
					);
					break;
				}

				case "discuss": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const slice = rest[0] ? getSlice(database, rest[0]) : findActiveSlice(database);
					if (!slice) {
						if (ctx.hasUI) ctx.ui.notify("No active slice found.", "error");
						return;
					}
					const validation = validateDiscuss(database, slice.id);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules.discuss;
					if (!mod) return;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					await mod.run(phaseCtx);
					break;
				}

				case "research": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const slice = rest[0] ? getSlice(database, rest[0]) : findActiveSlice(database);
					if (!slice) {
						if (ctx.hasUI) ctx.ui.notify("No active slice found.", "error");
						return;
					}
					const validation = validateResearch(database, slice.id);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules.research;
					if (!mod) return;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					await mod.run(phaseCtx);
					break;
				}

				case "plan": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const slice = rest[0] ? getSlice(database, rest[0]) : findActiveSlice(database);
					if (!slice) {
						if (ctx.hasUI) ctx.ui.notify("No active slice found.", "error");
						return;
					}
					const validation = validatePlan(database, slice.id);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules.plan;
					if (!mod) return;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					await mod.run(phaseCtx);
					break;
				}

				case "next": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const validation = validateNext(database);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const sliceId = validation.sliceId;
					const phase = validation.phase;
					if (!sliceId || !phase) return;
					const slice = getSlice(database, sliceId);
					if (!slice) return;
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules[phase];
					if (!mod) return;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					await mod.run(phaseCtx);
					break;
				}

				case "auto": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const validation = validateAuto(database);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					let currentSlice = findActiveSlice(database);
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const MAX_AUTO_ITERATIONS = 20;
					let iterations = 0;
					while (currentSlice && iterations < MAX_AUTO_ITERATIONS) {
						iterations++;
						const phase = determineNextPhase(currentSlice.status, currentSlice.tier);
						if (!phase) break;
						const mod = phaseModules[phase];
						if (!mod) break;
						const milestone = getMilestone(database, currentSlice.milestoneId);
						if (!milestone) break;
						const phaseCtx: PhaseContext = {
							pi,
							db: database,
							root,
							slice: currentSlice,
							milestoneNumber: milestone.number,
							settings: currentSettings,
						};
						const result = await mod.run(phaseCtx);
						if (!result.success) break;
						currentSlice = findActiveSlice(database);
					}
					if (iterations >= MAX_AUTO_ITERATIONS) {
						if (ctx.hasUI) ctx.ui.notify("Auto mode: max iterations reached.", "warning");
					}
					break;
				}

				case "pause": {
					const database = getDb();
					const slice = rest[0] ? getSlice(database, rest[0]) : findActiveSlice(database);
					if (!slice) {
						if (ctx.hasUI) ctx.ui.notify("No active slice found.", "error");
						return;
					}
					const pauseResult = handlePause(database, slice.id);
					if (!pauseResult.success) {
						if (ctx.hasUI) ctx.ui.notify(pauseResult.error ?? "Unknown error", "error");
					} else {
						if (ctx.hasUI) ctx.ui.notify(`Slice ${slice.id} paused.`, "info");
					}
					break;
				}

				default: {
					pi.sendUserMessage(
						`\`/tff ${subcommand}\` is not yet implemented in this version of TFF.`,
					);
					break;
				}
			}
		},
	});

	// -------------------------------------------------------------------------
	// AI Tool: tff_query_state
	// -------------------------------------------------------------------------
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
						description: "Milestone or slice ID (required for scope=milestone and scope=slice)",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					let result: unknown;
					if (params.scope === "overview") {
						result = queryState(database, "overview");
					} else if (params.scope === "milestone") {
						result = queryState(database, "milestone", params.id ?? "");
					} else {
						result = queryState(database, "slice", params.id ?? "");
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_transition
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_transition",
			label: "TFF Transition Slice",
			description:
				"Transition a slice to a new status. Validates the transition is allowed by the state machine. If targetStatus is omitted, advances to the next status.",
			parameters: Type.Object({
				sliceId: Type.String({
					description: "The ID of the slice to transition",
				}),
				targetStatus: Type.Optional(
					StringEnum([...SLICE_STATUSES], {
						description:
							"The target status to transition to. If omitted, advances to the next logical status.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					return handleTransition(database, params.sliceId, params.targetStatus);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_classify
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_classify",
			label: "TFF Classify Slice",
			description:
				"Set the tier (complexity classification) of a slice. S = simple (skip research), SS = standard, SSS = complex.",
			parameters: Type.Object({
				sliceId: Type.String({
					description: "The ID of the slice to classify",
				}),
				tier: StringEnum([...TIERS], {
					description: "Tier: S (simple), SS (standard), SSS (complex)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					return handleClassify(database, params.sliceId, params.tier as (typeof TIERS)[number]);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_create_project
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_create_project",
			label: "TFF Create Project",
			description:
				"Create a new TFF project with name and vision. Call this after brainstorming with the user via /tff new. Use /tff new-milestone to add milestones afterwards.",
			parameters: Type.Object({
				projectName: Type.String({ description: "Name of the project" }),
				vision: Type.String({ description: "Vision statement for the project" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const database = getDb();
				const root = projectRoot;
				if (!root) {
					return {
						content: [{ type: "text", text: "Error: No project root found." }],
						details: {},
						isError: true,
					};
				}
				return handleCreateProject(database, root, {
					projectName: params.projectName,
					vision: params.vision,
				});
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_create_slice
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_create_slice",
			label: "TFF Create Slice",
			description:
				"Create a new slice within a milestone. A slice is a unit of work that goes through the discuss → research → plan → execute → verify → ship lifecycle.",
			parameters: Type.Object({
				milestoneId: Type.String({
					description: "The ID of the milestone to add this slice to",
				}),
				title: Type.String({
					description: "Short descriptive title for the slice",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const root = projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					return handleCreateSlice(database, root, params.milestoneId, params.title);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { milestoneId: params.milestoneId },
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_spec
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_spec",
			label: "TFF Write Spec",
			description:
				"Write the SPEC.md artifact for a slice. Called by the brainstormer agent during the discuss phase.",
			parameters: Type.Object({
				sliceId: Type.String({
					description: "The ID of the slice to write the spec for",
				}),
				content: Type.String({
					description: "The markdown content of the spec",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const root = projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					return handleWriteSpec(database, root, params.sliceId, params.content);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_research
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_research",
			label: "TFF Write Research",
			description:
				"Write the RESEARCH.md artifact for a slice. Called by the researcher agent during the research phase.",
			parameters: Type.Object({
				sliceId: Type.String({
					description: "The ID of the slice to write the research for",
				}),
				content: Type.String({
					description: "The markdown content of the research document",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const root = projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					return handleWriteResearch(database, root, params.sliceId, params.content);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_plan
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_plan",
			label: "TFF Write Plan",
			description:
				"Write the PLAN.md artifact for a slice and register tasks with dependency graph. Called by the planner agent during the plan phase.",
			parameters: Type.Object({
				sliceId: Type.String({
					description: "The ID of the slice to write the plan for",
				}),
				content: Type.String({
					description: "The markdown content of the plan",
				}),
				tasks: Type.Array(
					Type.Object({
						title: Type.String({ description: "Short task title" }),
						description: Type.String({ description: "What this task involves" }),
						dependsOn: Type.Optional(
							Type.Array(Type.Number(), {
								description:
									"1-based indices of tasks this depends on (e.g. [1, 3] means depends on task 1 and task 3)",
							}),
						),
						files: Type.Optional(
							Type.Array(Type.String(), {
								description: "Files this task will touch",
							}),
						),
					}),
					{ description: "List of tasks that make up the implementation plan" },
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const root = projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					return handleWritePlan(
						database,
						root,
						params.sliceId,
						params.content,
						params.tasks as TaskInput[],
					);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);
}
