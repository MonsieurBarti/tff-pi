import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
import { shutdownFffBridge } from "./common/fff-integration.js";
import { getGitRoot } from "./common/git.js";
import { initMonitoring } from "./common/monitoring-setup.js";
import { clearPendingMessage, readPendingMessage } from "./common/phase.js";
import { readProjectIdFile } from "./common/project-home.js";
import { diagnoseRecovery, formatRecoveryBriefing, scanForStuckSlices } from "./common/recovery.js";
import { type SessionLock, isLockStale, readLock } from "./common/session-lock.js";
import { loadSettings } from "./common/settings.js";
import { ensureStateBranch } from "./common/state-branch.js";
import { ToolCallLogger, type ToolCallLoggerPi } from "./common/tool-call-logger.js";
import { ensureSliceWorktree } from "./common/worktree.js";
import { detectRenameAlert } from "./lifecycle-rename-detect.js";
import { type PendingWorktreeMarker, pendingWorktreeMarkerPath } from "./phases/execute.js";
import { checkForUpdates } from "./update-check.js";

/**
 * If `execute.prepare()` wrote a pending-execute-worktree.json marker, consume
 * it: call `ensureSliceWorktree` (idempotent) then delete the file. Best-effort
 * — a failure here is logged but never blocks session_start.
 */
function maybeEnsureWorktreeFromMarker(root: string): void {
	const markerPath = pendingWorktreeMarkerPath(root);
	if (!existsSync(markerPath)) return;
	let marker: PendingWorktreeMarker;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf-8")) as PendingWorktreeMarker;
	} catch {
		// Malformed marker — delete and move on
		try {
			unlinkSync(markerPath);
		} catch {
			// ignore
		}
		return;
	}
	try {
		ensureSliceWorktree(root, marker.sliceLabel, { id: marker.sliceId }, marker.milestoneBranch);
	} catch {
		// best-effort: leave marker so next session can retry
		return;
	}
	try {
		unlinkSync(markerPath);
	} catch {
		// ignore
	}
}

/**
 * Crash-recovery scan executed on cold startup. If the previous session left a
 * stale (or missing) lock and there is a stuck slice in the DB, surface a
 * recovery briefing to the user. Invoked
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
	} catch {
		// Best-effort — don't crash on recovery scan failure
	}
}

/**
 * Wires all three session lifecycle hooks: session_start (project init,
 * crash-recovery scan on cold startup, extension update check),
 * session_shutdown (fff bridge shutdown, db close),
 * and before_agent_start (system prompt injection).
 *
 * Moved out of the entry point to keep index.ts thin; no behavior change.
 */
export function registerLifecycleHooks(pi: ExtensionAPI, ctx: TffContext): void {
	// Subscribe ToolCallLogger ONCE at extension init.
	// PI's api.on is extension-scoped and append-only (handlers never cleared
	// across sessions), so subscribing inside session_start would duplicate
	// handlers on every phase transition — each tool call would fire N+1
	// handlers after N newSession cycles. The instance must live for the
	// extension's full lifetime because its closures are pinned in PI's
	// handler list; disposing per-session would break the next session's
	// receipt of tool_call events.
	const piAdapter: ToolCallLoggerPi = {
		on: (event, handler) => {
			pi.on(event as Parameters<typeof pi.on>[0], handler as never);
			return () => {};
		},
	};
	ctx.toolCallLogger = new ToolCallLogger(piAdapter, pi.events);
	ctx.toolCallLogger.subscribe();

	// -------------------------------------------------------------------------
	// Lifecycle: session_start
	// -------------------------------------------------------------------------
	pi.on("session_start", async (event, uiCtx) => {
		// On startup (fresh PI launch), check for a disk-stashed pending phase
		// message first. A pending message means PI froze during a newSession()
		// call and was manually restarted — the message is still valid and must
		// be delivered. If no pending message exists, fall through to the
		// crash-recovery scan below. Delivering the pending message takes
		// precedence over the generic recovery scan.
		let pendingDelivered = false;
		if (event.reason === "startup") {
			const startupRoot = getGitRoot();
			if (startupRoot) {
				const pendingMessage = readPendingMessage(startupRoot);
				if (pendingMessage) {
					// Materialise the worktree before the agent sees the message so the
					// path referenced in the prompt already exists on disk.
					maybeEnsureWorktreeFromMarker(startupRoot);
					clearPendingMessage(startupRoot);
					try {
						pi.sendMessage(
							{ customType: "tff-phase", content: pendingMessage, display: true },
							{ triggerTurn: true },
						);
						pendingDelivered = true;
					} catch (err) {
						if (uiCtx.hasUI) {
							uiCtx.ui.notify(
								`Failed to deliver pending phase prompt: ${err instanceof Error ? err.message : String(err)}`,
								"error",
							);
						}
					}
				}
			}
		}

		// On phase transition (await cmdCtx.newSession() in runPhaseWithFreshContext),
		// pick up the disk-stashed phase prompt and deliver it using THIS session's
		// fresh `pi` handle. The command handler can't deliver it directly because
		// the `pi` it captured is bound to the now-disposed old session's runtime.
		if (event.reason === "new") {
			const earlyRoot = getGitRoot();
			if (earlyRoot) {
				// Materialise the worktree before the agent sees the message so the
				// path referenced in the prompt already exists on disk.
				maybeEnsureWorktreeFromMarker(earlyRoot);
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

		// Refresh ultra-compress active level from user's state store
		await refreshCompressionLevel(root);

		const dbPath = tffPath(root, "state.db");
		if (existsSync(join(root, ".tff")) && existsSync(dbPath)) {
			try {
				ctx.db = openDatabase(dbPath);
				applyMigrations(ctx.db, { root: ctx.projectRoot });
				loadSettings(ctx, root);

				// M10-S03/S5: ensure tff-state/<codeBranch> exists and alert on rename.
				// Best-effort: a broken state branch must never block session start.
				// Detect BEFORE ensureStateBranch so lastKnownCodeBranch still
				// reflects the previous code branch during comparison.
				try {
					const projectId = readProjectIdFile(root);
					if (projectId) {
						await detectRenameAlert(root, projectId, (msg) => pi.sendUserMessage(msg));
						await ensureStateBranch(root, projectId);
					}
				} catch (err) {
					console.warn(`state-branch preflight failed (root=${root}):`, err);
				}

				ctx.initError = null;

				// Initialize monitoring (EventLogger + TUIMonitor + fffBridge)
				await initMonitoring(pi, ctx, root, uiCtx);

				if (uiCtx.hasUI) {
					uiCtx.ui.notify("TFF ready", "info");
				}

				// Crash-recovery scan runs only on cold startup. Phase transitions
				// fire session_start with reason="new" while a slice is legitimately
				// mid-flow (status=planning/executing/etc.); running the scan there
				// would flag the in-flight slice as stuck AND call sendUserMessage
				// after we just triggered a turn via sendMessage — PI would then
				// report "Agent is already processing".
				// Skip the scan when we already delivered a pending-phase message:
				// the pending message is a stronger signal than a generic stall.
				if (event.reason === "startup" && !pendingDelivered) {
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
		ctx.eventLogger = null;
		ctx.tuiMonitor = null;
		await shutdownFffBridge();
		ctx.fffBridge = null;
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
