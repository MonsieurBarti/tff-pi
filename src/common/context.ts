import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import type { EventLogger } from "./event-logger.js";
import type { FffBridge } from "./fff-integration.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";
import type { ToolCallLogger } from "./tool-call-logger.js";
import type { TUIMonitor } from "./tui-monitor.js";

/**
 * Session-scoped mutable state for the TFF extension. Populated by the
 * `session_start` lifecycle hook; every handler (slash command or AI tool)
 * reads from `ctx.*` at call time so stale references never capture.
 *
 * Fields default to `null` until `session_start` runs — handlers must guard
 * against that case (typically by calling `requireProject`).
 */
export interface TffContext {
	db: Database.Database | null;
	projectRoot: string | null;
	settings: Settings | null;
	fffBridge: FffBridge | null;
	eventLogger: EventLogger | null;
	toolCallLogger: ToolCallLogger | null;
	tuiMonitor: TUIMonitor | null;
	cmdCtx: ExtensionCommandContext | null;
	initError: string | null;
}

/**
 * Non-null project bundle returned by `requireProject`. Handlers receive all
 * three fields together so they don't each re-reach into `ctx` and drift.
 */
export interface ProjectContext {
	db: Database.Database;
	root: string;
	settings: Settings;
}

export function createTffContext(): TffContext {
	return {
		db: null,
		projectRoot: null,
		settings: null,
		fffBridge: null,
		eventLogger: null,
		toolCallLogger: null,
		tuiMonitor: null,
		cmdCtx: null,
		initError: null,
	};
}

/**
 * Returns the active database handle, or throws if the project isn't initialized.
 * Every command handler that needs the DB should go through this helper so the
 * error message stays consistent.
 */
export function getDb(ctx: TffContext): Database.Database {
	if (!ctx.db) {
		throw new Error("TFF database not initialized. Run `/tff new` to set up the project.");
	}
	return ctx.db;
}

/**
 * Returns the db/root/settings bundle if the extension has been initialized
 * (`/tff new` has run in this git repo). Otherwise notifies the user via the
 * command context and returns null — callers should `return;` on null.
 */
export function requireProject(
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
): ProjectContext | null {
	if (!ctx.db || !ctx.projectRoot) {
		if (uiCtx?.hasUI) {
			uiCtx.ui.notify("TFF not initialized. Run /tff new first.", "error");
		}
		return null;
	}
	return {
		db: ctx.db,
		root: ctx.projectRoot,
		settings: ctx.settings ?? DEFAULT_SETTINGS,
	};
}
