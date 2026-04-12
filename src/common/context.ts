import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import type { EventLogger } from "./event-logger.js";
import type { FffBridge } from "./fff-integration.js";
import type { Settings } from "./settings.js";
import type { TUIMonitor } from "./tui-monitor.js";

/**
 * Session-scoped mutable state for the TFF extension. Populated by the
 * `session_start` lifecycle hook; every handler (slash command or AI tool)
 * reads from `ctx.*` at call time so stale references never capture.
 *
 * Fields default to `null` until `session_start` runs — handlers must guard
 * against that case (typically by emitting a "no project" error).
 */
export interface TffContext {
	pi: ExtensionAPI;
	db: Database.Database | null;
	projectRoot: string | null;
	settings: Settings | null;
	fffBridge: FffBridge | null;
	eventLogger: EventLogger | null;
	tuiMonitor: TUIMonitor | null;
	cmdCtx: ExtensionCommandContext | null;
	initError: string | null;
}

export function createTffContext(pi: ExtensionAPI): TffContext {
	return {
		pi,
		db: null,
		projectRoot: null,
		settings: null,
		fffBridge: null,
		eventLogger: null,
		tuiMonitor: null,
		cmdCtx: null,
		initError: null,
	};
}
