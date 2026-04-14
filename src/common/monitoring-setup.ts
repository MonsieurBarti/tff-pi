import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { tffPath } from "./artifacts.js";
import type { TffContext } from "./context.js";
import { EventLogger } from "./event-logger.js";
import { initFffBridge } from "./fff-integration.js";
import { TUIMonitor } from "./tui-monitor.js";

/**
 * Initialize EventLogger + TUIMonitor + fffBridge after DB creation or
 * discovery. Idempotent: if eventLogger is already set, no-op.
 *
 * Called from two places:
 *   1. session_start (in lifecycle.ts) — when PI starts up with an existing
 *      project DB.
 *   2. runNew (in commands/new.ts) — when `/tff new` creates the DB mid-session.
 *
 * Both paths need monitoring wired up so phase_start / phase_complete events
 * on `pi.events` reach the EventLogger and trigger reconcileSliceStatus.
 */
export async function initMonitoring(
	pi: ExtensionAPI,
	ctx: TffContext,
	root: string,
	uiCtx: ExtensionContext | null,
): Promise<void> {
	if (!ctx.db) return; // no DB, nothing to wire
	if (ctx.eventLogger) return; // already initialized

	const logsDir = tffPath(root, "logs");
	ctx.eventLogger = new EventLogger(ctx.db, logsDir, root);
	ctx.eventLogger.subscribe(pi.events);

	if (uiCtx?.hasUI) {
		ctx.tuiMonitor = new TUIMonitor(uiCtx.ui);
		ctx.tuiMonitor.subscribe(pi.events);
	}

	ctx.fffBridge = await initFffBridge(root);
}
