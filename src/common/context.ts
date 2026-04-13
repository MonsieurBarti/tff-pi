import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { getMilestone, getMilestones, getProject, getSlice, getSlices } from "./db.js";
import type { EventLogger } from "./event-logger.js";
import type { FffBridge } from "./fff-integration.js";
import type { Settings } from "./settings.js";
import type { TUIMonitor } from "./tui-monitor.js";
import type { Milestone, Slice } from "./types.js";

/**
 * Session-scoped mutable state for the TFF extension. Populated by the
 * `session_start` lifecycle hook; every handler (slash command or AI tool)
 * reads from `ctx.*` at call time so stale references never capture.
 *
 * Fields default to `null` until `session_start` runs — handlers must guard
 * against that case (typically by emitting a "no project" error).
 */
export interface TffContext {
	db: Database.Database | null;
	projectRoot: string | null;
	settings: Settings | null;
	fffBridge: FffBridge | null;
	eventLogger: EventLogger | null;
	tuiMonitor: TUIMonitor | null;
	cmdCtx: ExtensionCommandContext | null;
	initError: string | null;
}

export function createTffContext(): TffContext {
	return {
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
 * Look up a slice by its human-readable `M<nn>-S<nn>` label by traversing
 * project → milestones → slices. Returns null if the label is malformed or
 * no matching slice exists.
 */
export function findSliceByLabel(db: Database.Database, label: string): Slice | null {
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

/**
 * Look up a milestone by its human-readable `M<nn>` label. Returns null if
 * the label is malformed or no matching milestone exists.
 */
export function findMilestoneByLabel(db: Database.Database, label: string): Milestone | null {
	const match = label.match(/^M(\d+)$/i);
	if (!match || !match[1]) return null;
	const mNum = Number.parseInt(match[1], 10);
	const project = getProject(db);
	if (!project) return null;
	const milestones = getMilestones(db, project.id);
	return milestones.find((m) => m.number === mNum) ?? null;
}

/**
 * Resolve a slice by user-supplied reference: tries label lookup first, then
 * falls back to treating the ref as a raw slice id.
 */
export function resolveSlice(db: Database.Database, ref: string): Slice | null {
	return findSliceByLabel(db, ref) ?? getSlice(db, ref);
}

/**
 * Resolve a milestone by user-supplied reference: tries label lookup first,
 * then falls back to treating the ref as a raw milestone id.
 */
export function resolveMilestone(db: Database.Database, ref: string): Milestone | null {
	return findMilestoneByLabel(db, ref) ?? getMilestone(db, ref);
}
