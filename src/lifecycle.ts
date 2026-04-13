import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { tffPath } from "./common/artifacts.js";
import { refreshCompressionLevel } from "./common/compress.js";
import { buildContextBlock } from "./common/context-injection.js";
import type { TffContext } from "./common/context.js";
import {
	applyMigrations,
	getActiveMilestone,
	getActiveSlice,
	getMilestone,
	getProject,
	openDatabase,
} from "./common/db.js";
import { EventLogger } from "./common/event-logger.js";
import { initFffBridge, shutdownFffBridge } from "./common/fff-integration.js";
import { getGitRoot } from "./common/git.js";
import { getMemory, initMemory, shutdownMemory } from "./common/memory.js";
import { clearPendingMessage, readPendingMessage } from "./common/phase.js";
import { diagnoseRecovery, formatRecoveryBriefing, scanForStuckSlices } from "./common/recovery.js";
import { type SessionLock, isLockStale, readLock } from "./common/session-lock.js";
import { loadSettings } from "./common/settings.js";
import { ToolCallLogger, type ToolCallLoggerPi } from "./common/tool-call-logger.js";
import { TUIMonitor } from "./common/tui-monitor.js";
import { checkForUpdates } from "./update-check.js";

/**
 * Crash-recovery scan executed on cold startup. If the previous session left a
 * stale (or missing) lock and there is a stuck slice in the DB, surface a
 * recovery briefing to the user and log the crash to hippo-memory. Invoked
 * only when `event.reason === "startup"` so phase transitions (reason="new")
 * don't misflag in-flight slices. Best-effort: any internal failure is
 * swallowed so a broken scan can't block the rest of session_start.
 */
async function maybeRunCrashRecoveryScan(
	pi: ExtensionAPI,
	ctx: TffContext,
	root: string,
	lock: SessionLock | null,
): Promise<void> {
	try {
		const lockIsStale = lock && isLockStale(lock);
		const needsScan = lockIsStale || !lock;
		if (!needsScan || !ctx.db) return;

		const stuck = scanForStuckSlices(ctx.db);
		if (stuck.length === 0) return;
		const stuckSlice = stuck[0];
		if (!stuckSlice) return;

		const milestone = getMilestone(ctx.db, stuckSlice.milestoneId);
		if (!milestone) return;

		const diagnosis = diagnoseRecovery(root, ctx.db, stuckSlice.id, milestone.number);
		const briefing = formatRecoveryBriefing(diagnosis, lock?.timestamp);
		pi.sendUserMessage(briefing, { deliverAs: "steer" });

		// Log crash to hippo-memory (best-effort)
		const memory = getMemory();
		if (memory) {
			try {
				await memory.remember({
					content: `Crash during ${diagnosis.status} phase on ${diagnosis.sliceLabel}. Classification: ${diagnosis.classification}. Lock timestamp: ${lock?.timestamp ?? "unknown"}.`,
					tags: ["tff-crash", "recovery", diagnosis.status],
					kind: "observed",
				});
			} catch {
				// best-effort
			}
		}
	} catch {
		// Best-effort — don't crash on recovery scan failure
	}
}

/**
 * Wires all three session lifecycle hooks: session_start (project init,
 * crash-recovery scan on cold startup, extension update check),
 * session_shutdown (db close, memory shutdown, fff bridge shutdown),
 * and before_agent_start (system prompt injection).
 *
 * Moved out of the entry point to keep index.ts thin; no behavior change.
 */
export function registerLifecycleHooks(pi: ExtensionAPI, ctx: TffContext): void {
	// -------------------------------------------------------------------------
	// Lifecycle: session_start
	// -------------------------------------------------------------------------
	pi.on("session_start", async (event, uiCtx) => {
		// On startup (fresh PI launch), proactively clear any leftover pending
		// phase message — it's from a crashed session, not useful anymore.
		if (event.reason === "startup") {
			const startupRoot = getGitRoot();
			if (startupRoot) {
				clearPendingMessage(startupRoot);
			}
		}

		// On phase transition (await cmdCtx.newSession() in runPhaseWithFreshContext),
		// pick up the disk-stashed phase prompt and deliver it using THIS session's
		// fresh `pi` handle. The command handler can't deliver it directly because
		// the `pi` it captured is bound to the now-disposed old session's runtime.
		if (event.reason === "new") {
			const earlyRoot = getGitRoot();
			if (earlyRoot) {
				const message = readPendingMessage(earlyRoot);
				if (message) {
					clearPendingMessage(earlyRoot);
					try {
						pi.sendMessage(
							{ customType: "tff-phase", content: message, display: true },
							{ triggerTurn: true },
						);
					} catch (err) {
						if (uiCtx.hasUI) {
							uiCtx.ui.notify(
								`Failed to deliver phase prompt: ${err instanceof Error ? err.message : String(err)}`,
								"error",
							);
						}
					}
				}
			}
		}

		const root = getGitRoot();
		if (!root) {
			return;
		}
		ctx.projectRoot = root;

		// hippo-memory is a required peer dep — initialize it eagerly.
		await initMemory(root);

		// Refresh ultra-compress active level from user's state store
		await refreshCompressionLevel(root);

		const dbPath = tffPath(root, "state.db");
		if (existsSync(join(root, ".tff")) && existsSync(dbPath)) {
			try {
				ctx.db = openDatabase(dbPath);
				applyMigrations(ctx.db);
				loadSettings(ctx, root);
				ctx.initError = null;

				// Initialize monitoring
				const logsDir = tffPath(root, "logs");
				ctx.eventLogger = new EventLogger(ctx.db, logsDir);
				ctx.eventLogger.subscribe(pi.events);

				// ExtensionAPI.on returns void, but ToolCallLoggerPi expects a disposer.
				// Extension handlers are cleared on session_shutdown, so a no-op unsubscribe is safe.
				const piAdapter: ToolCallLoggerPi = {
					on: (event, handler) => {
						pi.on(event as Parameters<typeof pi.on>[0], handler as never);
						return () => {};
					},
				};
				ctx.toolCallLogger = new ToolCallLogger(piAdapter, pi.events);
				ctx.toolCallLogger.subscribe();

				if (uiCtx.hasUI) {
					ctx.tuiMonitor = new TUIMonitor(uiCtx.ui);
					ctx.tuiMonitor.subscribe(pi.events);
					uiCtx.ui.notify("TFF ready", "info");
				}

				// fff-pi bridge: enriches plan/execute phase prompts with related files.
				ctx.fffBridge = await initFffBridge(root);

				// Crash-recovery scan runs only on cold startup. Phase transitions
				// fire session_start with reason="new" while a slice is legitimately
				// mid-flow (status=planning/executing/etc.); running the scan there
				// would flag the in-flight slice as stuck AND call sendUserMessage
				// after we just triggered a turn via sendMessage — PI would then
				// report "Agent is already processing".
				if (event.reason === "startup") {
					await maybeRunCrashRecoveryScan(pi, ctx, root, readLock(root));
				}
			} catch (err) {
				ctx.initError = err instanceof Error ? err.message : String(err);
			}
		}

		// Check for extension updates
		const updateInfo = await checkForUpdates(pi);
		if (updateInfo?.updateAvailable && uiCtx.hasUI) {
			uiCtx.ui.notify(
				`📦 Update available: ${updateInfo.latestVersion} (you have ${updateInfo.currentVersion}). Run: pi install npm:@the-forge-flow/tff-pi`,
				"info",
			);
		}
	});

	// -------------------------------------------------------------------------
	// Lifecycle: session_shutdown
	// -------------------------------------------------------------------------
	pi.on("session_shutdown", async () => {
		ctx.toolCallLogger?.dispose();
		ctx.toolCallLogger = null;
		ctx.eventLogger = null;
		ctx.tuiMonitor = null;
		await shutdownFffBridge();
		ctx.fffBridge = null;
		await shutdownMemory();
		if (ctx.db) {
			ctx.db.close();
			ctx.db = null;
		}
	});

	// -------------------------------------------------------------------------
	// Lifecycle: before_agent_start — inject TFF context into system prompt
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (event, _uiCtx) => {
		if (!ctx.db || !ctx.projectRoot) return undefined;

		const project = getProject(ctx.db);
		if (!project) return undefined;

		const milestone = getActiveMilestone(ctx.db, project.id);
		const slice = milestone ? getActiveSlice(ctx.db, milestone.id) : null;

		const contextBlock = buildContextBlock({
			root: ctx.projectRoot,
			project,
			milestone,
			slice,
			settings: ctx.settings ?? undefined,
		});

		if (!contextBlock) return undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${contextBlock}`,
		};
	});
}
