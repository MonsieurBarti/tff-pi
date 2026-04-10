import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { handleProgress } from "./commands/progress.js";
import { handleStatus } from "./commands/status.js";
import { initTffDirectory, readArtifact, tffPath } from "./common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	openDatabase,
	updateSliceStatus,
	updateSliceTier,
} from "./common/db.js";
import { getGitRoot } from "./common/git.js";
import { isValidSubcommand, parseSubcommand } from "./common/router.js";
import { DEFAULT_SETTINGS, type Settings, parseSettings } from "./common/settings.js";
import { canTransitionSlice, nextSliceStatus } from "./common/state-machine.js";
import type { SliceStatus, Tier } from "./common/types.js";
import { queryState } from "./tools/query-state.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let projectRoot: string | null = null;
let settings: Settings | null = null;

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
	const dbPath = tffPath(root, "tff.db");
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

		const dbPath = tffPath(root, "tff.db");
		if (existsSync(join(root, ".tff")) && existsSync(dbPath)) {
			try {
				db = openDatabase(dbPath);
				applyMigrations(db);
				loadSettings(root);
				if (ctx.hasUI) {
					ctx.ui.notify("TFF ready", "info");
				}
			} catch {
				// Non-fatal: .tff exists but something failed
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
						`You are setting up a new TFF project. The user wants to create a project called "${projectName}".\n\nPlease help them brainstorm:\n1. A clear vision statement for the project\n2. The name and goal of the first milestone (M01)\n3. A list of slices (high-level work items) for M01\n\nOnce we have that information, use the tff_query_state tool (scope: overview) to check if a project already exists, then guide the user through creating the project structure.`,
					);
					break;
				}

				case "help": {
					pi.sendUserMessage(
						"Here are the available TFF commands:\n\n" +
							"- `/tff new [name]` — Start a new project (AI-assisted brainstorm)\n" +
							"- `/tff status` — Show current project status\n" +
							"- `/tff progress` — Show detailed progress table\n" +
							"- `/tff health` — Quick database health check\n" +
							"- `/tff settings` — Show current settings\n" +
							"- `/tff help` — Show this help\n\n" +
							"Slice workflow subcommands (coming soon):\n" +
							"new-milestone, discuss, research, plan, execute, verify, ship, complete-milestone, next, auto, pause, rollback",
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
						const project = getProject(database);
						if (!project) {
							msg =
								"TFF health: database connected, no project found. Run `/tff new` to create one.";
						} else {
							const milestones = getMilestones(database, project.id);
							let sliceCount = 0;
							for (const m of milestones) {
								sliceCount += getSlices(database, m.id).length;
							}
							msg = `TFF health: OK\n- Project: ${project.name}\n- Milestones: ${milestones.length}\n- Slices: ${sliceCount}\n- DB: connected`;
						}
					} catch (err) {
						msg = `TFF health: NOT OK — ${err instanceof Error ? err.message : String(err)}`;
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
					Type.String({
						description:
							"The target status to transition to. If omitted, advances to the next logical status.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const slice = getSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}

					const target = params.targetStatus
						? (params.targetStatus as SliceStatus)
						: nextSliceStatus(slice.status, slice.tier ?? undefined);

					if (!target) {
						return {
							content: [{ type: "text", text: `No valid next status from '${slice.status}'.` }],
							details: { sliceId: params.sliceId, currentStatus: slice.status },
							isError: true,
						};
					}

					if (!canTransitionSlice(slice.status, target)) {
						return {
							content: [
								{
									type: "text",
									text: `Invalid transition: '${slice.status}' → '${target}'. Allowed: ${canTransitionSlice.toString()}`,
								},
							],
							details: { sliceId: params.sliceId, from: slice.status, to: target },
							isError: true,
						};
					}

					updateSliceStatus(database, params.sliceId, target);

					return {
						content: [
							{
								type: "text",
								text: `Slice ${params.sliceId} transitioned: ${slice.status} → ${target}`,
							},
						],
						details: { sliceId: params.sliceId, from: slice.status, to: target },
					};
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
				tier: StringEnum(["S", "SS", "SSS"] as const, {
					description: "Tier: S (simple), SS (standard), SSS (complex)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const slice = getSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}

					updateSliceTier(database, params.sliceId, params.tier as Tier);

					return {
						content: [
							{
								type: "text",
								text: `Slice ${params.sliceId} classified as Tier ${params.tier}`,
							},
						],
						details: { sliceId: params.sliceId, tier: params.tier },
					};
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
