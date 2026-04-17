import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "./context.js";
import { initFffBridge } from "./fff-integration.js";
import { PerSliceLog } from "./per-slice-log.js";
import { TUIMonitor } from "./tui-monitor.js";

/**
 * Initialize PerSliceLog + TUIMonitor + fffBridge after DB creation or
 * discovery. Idempotent: if perSliceLog is already set, no-op.
 *
 * Called from two places:
 *   1. session_start (in lifecycle.ts) — when PI starts up with an existing
 *      project DB.
 *   2. runNew (in commands/new.ts) — when `/tff new` creates the DB mid-session.
 *
 * Both paths need monitoring wired up so events on `pi.events` reach
 * the PerSliceLog and are written to per-slice JSONL files.
 */
export async function initMonitoring(
	pi: ExtensionAPI,
	ctx: TffContext,
	root: string,
	uiCtx: ExtensionContext | null,
): Promise<void> {
	if (!ctx.db) return; // no DB, nothing to wire
	if (ctx.perSliceLog) return; // already initialized

	ctx.perSliceLog = new PerSliceLog(root);
	ctx.perSliceLog.subscribe(pi.events);

	if (uiCtx?.hasUI) {
		ctx.tuiMonitor = new TUIMonitor(uiCtx.ui);
		ctx.tuiMonitor.subscribe(pi.events);
	}

	ctx.fffBridge = await initFffBridge(root);
}
