import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	defineTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { handleCompleteMilestone } from "./commands/complete-milestone.js";
import { validateDiscuss } from "./commands/discuss.js";
import { validateExecute } from "./commands/execute.js";
import { handleHealth } from "./commands/health.js";
import { handleLogs } from "./commands/logs.js";
import { createMilestone } from "./commands/new-milestone.js";
import { validateNext } from "./commands/next.js";
import { validatePlan } from "./commands/plan.js";
import { handleProgress } from "./commands/progress.js";
import { validateResearch } from "./commands/research.js";
import { validateShip } from "./commands/ship.js";
import { handleStatus } from "./commands/status.js";
import { validateVerify } from "./commands/verify.js";
import { initTffDirectory, readArtifact, tffPath } from "./common/artifacts.js";
import { buildContextBlock } from "./common/context-injection.js";
import {
	applyMigrations,
	getActiveMilestone,
	getActiveSlice,
	getMilestone,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	openDatabase,
} from "./common/db.js";
import { DISCUSS_GATES, resetAllGates, unlockGate } from "./common/discuss-gates.js";
import { EventLogger } from "./common/event-logger.js";
import { type FffBridge, discoverFffService } from "./common/fff-integration.js";
import {
	addRemote,
	createGitignore,
	getGitRoot,
	hasRemote,
	initRepo,
	initialCommitAndPush,
} from "./common/git.js";
import { type PhaseContext, type PhaseModule, runPhaseWithFreshContext } from "./common/phase.js";
import { requestReview } from "./common/plannotator-review.js";
import { VALID_SUBCOMMANDS, isValidSubcommand, parseSubcommand } from "./common/router.js";
import { DEFAULT_SETTINGS, type Settings, parseSettings } from "./common/settings.js";
import { TUIMonitor } from "./common/tui-monitor.js";
import {
	type Phase,
	SLICE_STATUSES,
	type Slice,
	TIERS,
	milestoneLabel,
	sliceLabel,
} from "./common/types.js";
import { findActiveSlice } from "./orchestrator.js";
import { phaseModules } from "./phases/index.js";
import { handleClassify } from "./tools/classify.js";
import { handleCreateProject } from "./tools/create-project.js";
import { handleCreateSlice } from "./tools/create-slice.js";
import { queryState } from "./tools/query-state.js";
import { handleTransition } from "./tools/transition.js";
import { handleWritePlan } from "./tools/write-plan.js";
import { handleWriteResearch } from "./tools/write-research.js";
import { handleWriteRequirements, handleWriteSpec } from "./tools/write-spec.js";
import { checkForUpdates } from "./update-check.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let projectRoot: string | null = null;
let settings: Settings | null = null;
let initError: string | null = null;
let eventLogger: EventLogger | null = null;
let tuiMonitor: TUIMonitor | null = null;
let _fffBridge: FffBridge | null = null;
let cmdCtx: ExtensionCommandContext | null = null;

export function getCmdCtx() {
	return cmdCtx;
}

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

function findSliceByLabel(db: Database.Database, label: string): Slice | null {
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

function findMilestoneByLabel(
	db: Database.Database,
	label: string,
): ReturnType<typeof getMilestones>[number] | null {
	const match = label.match(/^M(\d+)$/i);
	if (!match || !match[1]) return null;
	const mNum = Number.parseInt(match[1], 10);
	const project = getProject(db);
	if (!project) return null;
	const milestones = getMilestones(db, project.id);
	return milestones.find((m) => m.number === mNum) ?? null;
}

function resolveSlice(db: Database.Database, ref: string): ReturnType<typeof getSlice> {
	return findSliceByLabel(db, ref) ?? getSlice(db, ref);
}

function resolveMilestone(
	db: Database.Database,
	ref: string,
): ReturnType<typeof getMilestones>[number] | null {
	return findMilestoneByLabel(db, ref) ?? getMilestone(db, ref);
}

async function runHeavyPhase(
	phase: Phase,
	mod: PhaseModule,
	phaseCtx: PhaseContext,
): Promise<void> {
	const result = await runPhaseWithFreshContext({
		phaseModule: mod,
		phaseCtx,
		cmdCtx,
		phase,
	});
	if (!result.success && result.error) {
		phaseCtx.pi.sendUserMessage(`Phase ${phase} failed: ${result.error}`);
	}
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
				resetAllGates();

				// Initialize monitoring
				const logsDir = tffPath(root, "logs");
				eventLogger = new EventLogger(db, logsDir);
				eventLogger.subscribe(pi.events);

				if (ctx.hasUI) {
					tuiMonitor = new TUIMonitor(ctx.ui);
					tuiMonitor.subscribe(pi.events);
					ctx.ui.notify("TFF ready", "info");
				}

				// Discover fff-pi
				_fffBridge = discoverFffService(pi);
			} catch (err) {
				initError = err instanceof Error ? err.message : String(err);
			}
		}

		// Check for extension updates
		const updateInfo = await checkForUpdates(pi);
		if (updateInfo?.updateAvailable && ctx.hasUI) {
			ctx.ui.notify(
				`📦 Update available: ${updateInfo.latestVersion} (you have ${updateInfo.currentVersion}). Run: pi install npm:@the-forge-flow/tff-pi`,
				"info",
			);
		}
	});

	// -------------------------------------------------------------------------
	// Lifecycle: session_shutdown
	// -------------------------------------------------------------------------
	pi.on("session_shutdown", async () => {
		eventLogger = null;
		tuiMonitor = null;
		_fffBridge = null;
		if (db) {
			db.close();
			db = null;
		}
	});

	// -------------------------------------------------------------------------
	// Lifecycle: before_agent_start — inject TFF context into system prompt
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!db || !projectRoot) return undefined;

		const project = getProject(db);
		if (!project) return undefined;

		const milestone = getActiveMilestone(db, project.id);
		const slice = milestone ? getActiveSlice(db, milestone.id) : null;

		const contextBlock = buildContextBlock({
			root: projectRoot,
			project,
			milestone,
			slice,
		});

		if (!contextBlock) return undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${contextBlock}`,
		};
	});

	// -------------------------------------------------------------------------
	// /tff command
	// -------------------------------------------------------------------------
	pi.registerCommand("tff", {
		description:
			"The Forge Flow — project workflow manager. Subcommands: new, status, progress, health, settings, help (and more)",
		getArgumentCompletions: (prefix: string) => {
			const { subcommand, args } = parseSubcommand(prefix);
			// Only suggest subcommands when the user hasn't completed the first word yet
			if (args.length > 0) return null;
			const items = VALID_SUBCOMMANDS.filter((cmd) => cmd.startsWith(subcommand)).map((cmd) => ({
				value: cmd,
				label: cmd,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			cmdCtx = ctx;
			const { subcommand, args: rest } = parseSubcommand(args);

			if (!isValidSubcommand(subcommand)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Unknown subcommand: ${subcommand}. Run \`/tff help\` for usage.`, "error");
				}
				return;
			}

			switch (subcommand) {
				case "new": {
					let root = getGitRoot() ?? projectRoot;
					if (!root) {
						initRepo(process.cwd());
						root = getGitRoot() ?? process.cwd();
					}
					createGitignore(root);
					projectRoot = root;
					initDb(root);
					loadSettings(root);

					const projectName = rest[0] ?? "New Project";
					const remoteInstruction = hasRemote(root)
						? ""
						: "\n\nIMPORTANT: No git remote is configured. Ask the user for their GitHub repository URL and call the tff_add_remote tool with it. This is required for the ship phase to create PRs.";
					pi.sendUserMessage(
						`You are setting up a new TFF project. The user wants to create a project called "${projectName}".\n\nPlease help them brainstorm:\n1. A clear vision statement for the project\n\nOnce agreed, call the tff_create_project tool with the project name and vision. After creating the project, suggest the user run /tff new-milestone.${remoteInstruction}`,
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
							"**Monitoring:**\n" +
							"- `/tff status` — Show current project status\n" +
							"- `/tff progress` — Show detailed progress table\n" +
							"- `/tff logs [M01-S01] [--json]` — Show event timeline for a slice\n" +
							"- `/tff health` — Quick database health check\n" +
							"- `/tff settings` — Show current settings\n" +
							"- `/tff help` — Show this help\n\n" +
							"**Execution:**\n" +
							"- `/tff execute [sliceId]` — Run the execute phase (wave-based task dispatch)\n" +
							"- `/tff verify [sliceId]` — Run verification (AC check + tests)\n" +
							"- `/tff ship [sliceId]` — Ship the slice (PR + merge)\n\n" +
							"- `/tff complete-milestone [M01]` — Create milestone PR after all slices ship",
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

				case "logs": {
					const db = getDb();
					const rawArgs = rest.join(" ").trim();
					const jsonFlag = rawArgs.includes("--json");
					const label = rawArgs.replace("--json", "").trim();
					const slice = label ? findSliceByLabel(db, label) : null;
					const activeSlice = findActiveSlice(db);
					const targetSlice = slice ?? activeSlice;
					if (!targetSlice) {
						pi.sendUserMessage("No slice found. Usage: `/tff logs [M01-S01] [--json]`");
						break;
					}
					const result = handleLogs(db, targetSlice.id, { json: jsonFlag });
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
						`Current TFF settings:\n\n- model_profile: ${current.model_profile}\n- compress.user_artifacts: ${current.compress.user_artifacts}\n- ship.auto_merge: ${current.ship.auto_merge}\n\nTo change settings, edit \`.tff/settings.yaml\` in your project root.`,
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
					const label = rest[0] ?? "";
					const slice = label
						? (findSliceByLabel(database, label) ?? getSlice(database, label))
						: findActiveSlice(database);
					if (!slice) {
						const msg = label ? `Slice not found: ${label}` : "No active slice found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
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
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					if (ctx.hasUI)
						ctx.ui.notify(
							`Starting discuss phase for ${sliceLabel(milestone.number, slice.number)}...`,
							"info",
						);
					await runHeavyPhase("discuss", mod, phaseCtx);
					break;
				}

				case "research": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const label = rest[0] ?? "";
					const slice = label
						? (findSliceByLabel(database, label) ?? getSlice(database, label))
						: findActiveSlice(database);
					if (!slice) {
						const msg = label ? `Slice not found: ${label}` : "No active slice found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
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
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					if (ctx.hasUI)
						ctx.ui.notify(
							`Starting research phase for ${sliceLabel(milestone.number, slice.number)}...`,
							"info",
						);
					await runHeavyPhase("research", mod, phaseCtx);
					break;
				}

				case "plan": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const label = rest[0] ?? "";
					const slice = label
						? (findSliceByLabel(database, label) ?? getSlice(database, label))
						: findActiveSlice(database);
					if (!slice) {
						const msg = label ? `Slice not found: ${label}` : "No active slice found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
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
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					if (ctx.hasUI)
						ctx.ui.notify(
							`Starting plan phase for ${sliceLabel(milestone.number, slice.number)}...`,
							"info",
						);
					await runHeavyPhase("plan", mod, phaseCtx);
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
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					await runHeavyPhase(phase, mod, phaseCtx);
					break;
				}

				case "execute": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const label = rest[0] ?? "";
					const slice = label
						? (findSliceByLabel(database, label) ?? getSlice(database, label))
						: findActiveSlice(database);
					if (!slice) {
						const msg = label ? `Slice not found: ${label}` : "No active slice found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
						return;
					}
					const validation = validateExecute(database, slice.id);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules.execute;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					if (ctx.hasUI)
						ctx.ui.notify(
							`Starting execute phase for ${sliceLabel(milestone.number, slice.number)}...`,
							"info",
						);
					await runHeavyPhase("execute", mod, phaseCtx);
					break;
				}

				case "verify": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const label = rest[0] ?? "";
					const slice = label
						? (findSliceByLabel(database, label) ?? getSlice(database, label))
						: findActiveSlice(database);
					if (!slice) {
						const msg = label ? `Slice not found: ${label}` : "No active slice found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
						return;
					}
					const validation = validateVerify(database, slice.id);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules.verify;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					if (ctx.hasUI)
						ctx.ui.notify(
							`Starting verify phase for ${sliceLabel(milestone.number, slice.number)}...`,
							"info",
						);
					await runHeavyPhase("verify", mod, phaseCtx);
					break;
				}

				case "ship": {
					const database = getDb();
					const root = projectRoot;
					if (!root) return;
					const label = rest[0] ?? "";
					const slice = label
						? (findSliceByLabel(database, label) ?? getSlice(database, label))
						: findActiveSlice(database);
					if (!slice) {
						const msg = label ? `Slice not found: ${label}` : "No active slice found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
						return;
					}
					const validation = validateShip(database, slice.id);
					if (!validation.valid) {
						if (ctx.hasUI) ctx.ui.notify(validation.error ?? "Unknown error", "error");
						return;
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) return;
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const mod = phaseModules.ship;
					const phaseCtx: PhaseContext = {
						pi,
						db: database,
						root,
						slice,
						milestoneNumber: milestone.number,
						settings: currentSettings,
					};
					if (ctx.hasUI)
						ctx.ui.notify(
							`Starting ship phase for ${sliceLabel(milestone.number, slice.number)}...`,
							"info",
						);
					const result = await runPhaseWithFreshContext({
						phaseModule: mod,
						phaseCtx,
						cmdCtx,
						phase: "ship",
					});
					if (result.success) {
						if (ctx.hasUI) ctx.ui.notify("Ship phase complete.", "info");
					} else if (result.retry && result.feedback) {
						// PR has review comments — re-enter execute with feedback
						if (ctx.hasUI)
							ctx.ui.notify("PR has review comments. Re-entering execute phase for fixes.", "info");
						const executeMod = phaseModules.execute;
						const freshSlice = getSlice(database, slice.id);
						if (freshSlice) {
							const execCtx: PhaseContext = {
								pi,
								db: database,
								root,
								slice: freshSlice,
								milestoneNumber: milestone.number,
								settings: currentSettings,
								feedback: result.feedback,
							};
							await runHeavyPhase("execute", executeMod, execCtx);
						}
					} else {
						if (ctx.hasUI)
							ctx.ui.notify(`Ship phase failed: ${result.error ?? "unknown error"}`, "error");
					}
					break;
				}

				case "complete-milestone": {
					const database = getDb();
					const root = projectRoot;
					if (!root) {
						if (ctx.hasUI) ctx.ui.notify("Not inside a git repository.", "error");
						return;
					}
					const label = rest[0] ?? "";
					const project = getProject(database);
					if (!project) {
						if (ctx.hasUI) ctx.ui.notify("No project found. Run /tff new first.", "error");
						return;
					}
					const milestone = label
						? resolveMilestone(database, label)
						: getActiveMilestone(database, project.id);
					if (!milestone) {
						const msg = label ? `Milestone not found: ${label}` : "No active milestone found.";
						if (ctx.hasUI) ctx.ui.notify(msg, "error");
						return;
					}
					const currentSettings = settings ?? DEFAULT_SETTINGS;
					const result = handleCompleteMilestone(database, root, milestone.id, currentSettings);
					if (result.success) {
						pi.sendUserMessage(
							`Milestone ${milestoneLabel(milestone.number)} "${milestone.name}" PR created: ${result.prUrl}`,
						);
					} else {
						pi.sendUserMessage(`Cannot complete milestone: ${result.error}`);
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
						description:
							"Milestone ID (UUID) or label (e.g., M01) for scope=milestone; slice ID (UUID) or label (e.g., M01-S01) for scope=slice",
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_transition
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_transition",
			label: "TFF Transition Slice",
			description:
				"Transition a slice to a new status. Validates the transition is allowed by the state machine. If targetStatus is omitted, advances to the next status. IMPORTANT: Only call this tool when the user explicitly asks to advance phases, or when running /tff auto. Never transition on your own initiative after a tool call.",
			promptSnippet:
				"IMPORTANT: Only call tff_transition when the user explicitly asks to advance phases, or when running /tff auto. Never transition on your own initiative after a tool call.",
			promptGuidelines: [
				"Do NOT call tff_transition automatically after writing specs or plans",
				"Always ask the user before transitioning to the next phase",
				"The /tff auto command handles transitions automatically — individual phases should not",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
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
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					return handleTransition(database, slice.id, params.targetStatus);
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
				"Set the tier (complexity classification) of a slice. S = simple (skip research), SS = standard, SSS = complex. During interactive discuss, requires tier confirmation gate via tff_confirm_gate.",
			promptSnippet:
				"Call tff_confirm_gate('tier_confirmed') before calling tff_classify. The system enforces this.",
			promptGuidelines: [
				"Requires tier_confirmed gate — call tff_confirm_gate('tier_confirmed') first",
				"Propose a tier to the user, get confirmation, then call tff_confirm_gate, then tff_classify",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				tier: StringEnum([...TIERS], {
					description: "Tier: S (simple), SS (standard), SSS (complex)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const tier = TIERS.find((t) => t === params.tier);
					if (!tier) {
						return {
							content: [{ type: "text", text: `Invalid tier: ${params.tier}` }],
							details: { tier: params.tier },
							isError: true,
						};
					}
					return handleClassify(database, slice.id, tier);
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
	// AI Tool: tff_confirm_gate
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_confirm_gate",
			label: "TFF Confirm Gate",
			description:
				"Confirm a discuss-phase gate after user approval. Gates: 'depth_verified' (unlocks tff_write_spec) and 'tier_confirmed' (unlocks tff_classify). Only call after the user has explicitly confirmed.",
			promptGuidelines: [
				"Call with gate='depth_verified' after user confirms they're ready to write the spec",
				"Call with gate='tier_confirmed' after user confirms the proposed tier classification",
				"Do NOT call without explicit user confirmation",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				gate: StringEnum(["depth_verified", "tier_confirmed"], {
					description: "The gate to unlock: 'depth_verified' or 'tier_confirmed'",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb();
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const gate = DISCUSS_GATES.find((g) => g === params.gate);
					if (!gate) {
						return {
							content: [{ type: "text", text: `Invalid gate: ${params.gate}` }],
							details: { gate: params.gate },
							isError: true,
						};
					}
					unlockGate(slice.id, gate);
					const gateLabel =
						params.gate === "depth_verified"
							? "Depth verified — tff_write_spec is now unlocked."
							: "Tier confirmed — tff_classify is now unlocked.";
					return {
						content: [{ type: "text", text: gateLabel }],
						details: { sliceId: slice.id, gate: params.gate },
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
	// AI Tool: tff_add_remote
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_add_remote",
			label: "TFF Add Remote",
			description:
				"Add a git remote origin and push the initial commit. Call this during /tff new when no remote is configured.",
			parameters: Type.Object({
				url: Type.String({
					description: "GitHub repository URL (e.g. https://github.com/user/repo.git)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const root = projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					const validHostPatterns = [
						/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//,
						/^git@(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org):/,
					];
					if (!validHostPatterns.some((p) => p.test(params.url))) {
						return {
							content: [
								{
									type: "text",
									text: "Error: URL must be from a known git host (github.com, gitlab.com, bitbucket.org, codeberg.org). If you need a different host, add the remote manually with `git remote add origin <url>`.",
								},
							],
							details: { url: params.url },
							isError: true,
						};
					}
					addRemote(params.url, root);
					initialCommitAndPush(root);
					return {
						content: [
							{
								type: "text",
								text: `Remote origin added (${params.url}) and initial commit pushed.`,
							},
						],
						details: { url: params.url },
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
						details: { url: params.url },
						isError: true,
					};
				}
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
					description: "The ID or label (e.g. 'M01') of the milestone to add this slice to",
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
					const milestone =
						findMilestoneByLabel(database, params.milestoneId) ??
						getMilestone(database, params.milestoneId);
					if (!milestone) {
						return {
							content: [
								{ type: "text", text: `Error: Milestone not found: ${params.milestoneId}` },
							],
							details: { milestoneId: params.milestoneId },
							isError: true,
						};
					}
					return handleCreateSlice(database, root, milestone.id, params.title);
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
				"Write the SPEC.md artifact for a slice. During interactive discuss, requires depth verification gate to be unlocked first via tff_confirm_gate.",
			promptSnippet:
				"Call tff_confirm_gate('depth_verified') before calling tff_write_spec. The system enforces this.",
			promptGuidelines: [
				"Requires depth_verified gate — call tff_confirm_gate('depth_verified') first",
				"Used during the discuss phase to write the spec after user confirms readiness",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
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
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const writeResult = handleWriteSpec(database, root, slice.id, params.content);
					if (!writeResult.isError) {
						requestReview(pi, String(writeResult.details.path), params.content, "spec");
					}
					return writeResult;
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
	// AI Tool: tff_write_requirements
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_requirements",
			label: "TFF Write Requirements",
			description:
				"Write the REQUIREMENTS.md artifact for a slice. Used during the discuss phase alongside SPEC.md.",
			promptGuidelines: [
				"Write REQUIREMENTS.md with R-IDs, classes, acceptance conditions, and verification instructions",
				"Used during the discuss phase after writing SPEC.md",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the requirements",
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
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const writeResult = handleWriteRequirements(database, root, slice.id, params.content);
					if (!writeResult.isError) {
						requestReview(pi, String(writeResult.details.path), params.content, "spec");
					}
					return writeResult;
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
				"Write the RESEARCH.md artifact for a slice. Called by the researcher agent during the research phase. Do NOT call directly — use /tff research instead.",
			promptSnippet:
				"Do NOT call tff_write_research directly. Use /tff research <slice> to run the research phase.",
			promptGuidelines: [
				"This tool is for sub-agents during phase execution, not for direct use",
				"To write research, tell the user to run /tff research <slice>",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
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
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					return handleWriteResearch(database, root, slice.id, params.content);
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
				"Write the PLAN.md artifact for a slice and register tasks with dependency graph. Triggers plannotator review after writing.",
			promptGuidelines: [
				"Write PLAN.md with tasks, dependencies, and implementation details",
				"Plannotator review opens automatically after writing",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
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
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const writeResult = handleWritePlan(
						database,
						root,
						slice.id,
						params.content,
						params.tasks,
					);
					if (!writeResult.isError) {
						requestReview(pi, String(writeResult.details.path), params.content, "plan");
					}
					return writeResult;
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
