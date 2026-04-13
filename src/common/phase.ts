import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import type { FffBridge } from "./fff-integration.js";
import { acquireLock, releaseLock } from "./session-lock.js";
import type { Settings } from "./settings.js";
import type { Phase, Slice } from "./types.js";

/**
 * Phase messages are stashed on disk because module-level state is not
 * guaranteed to survive the extension reload triggered by `newSession()`.
 * The session_start handler reads from here when `event.reason === "new"`.
 */
const PENDING_MESSAGE_FILE = "pending-phase-message.txt";

function pendingMessagePath(root: string): string {
	return join(root, ".tff", PENDING_MESSAGE_FILE);
}

export function writePendingMessage(root: string, message: string): void {
	mkdirSync(join(root, ".tff"), { recursive: true });
	writeFileSync(pendingMessagePath(root), message, "utf-8");
}

export function readPendingMessage(root: string): string | null {
	const p = pendingMessagePath(root);
	if (!existsSync(p)) return null;
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

export function clearPendingMessage(root: string): void {
	const p = pendingMessagePath(root);
	if (existsSync(p)) {
		try {
			unlinkSync(p);
		} catch {
			// best effort
		}
	}
}

export interface PhaseContext {
	pi: ExtensionAPI;
	db: Database.Database;
	root: string;
	slice: Slice;
	milestoneNumber: number;
	settings: Settings;
	feedback?: string;
	fffBridge?: FffBridge | null;
}

export interface PhasePrepareResult {
	success: boolean;
	retry: boolean;
	error?: string;
	feedback?: string;
	/** Optional prompt to deliver into a fresh session. When absent, no newSession is performed. */
	message?: string;
}

/** Backward-compatible alias — existing call sites using PhaseResult still type-check. */
export type PhaseResult = PhasePrepareResult;

export interface PhaseModule {
	prepare(ctx: PhaseContext): Promise<PhasePrepareResult>;
}

interface FreshContextOpts {
	phaseModule: PhaseModule;
	phaseCtx: PhaseContext;
	cmdCtx: ExtensionCommandContext | null;
	phase: Phase;
	/**
	 * Kept for API back-compat but no longer honored — newSession is fired
	 * fire-and-forget to avoid the deadlock described in the function body.
	 */
	timeoutMs?: number;
}

/**
 * Runs a phase's prepare() in the current session, stashes the resulting
 * prompt to disk, and schedules a fresh PI session to deliver it.
 *
 * **Critical: newSession() is fire-and-forget.** Awaiting it inside this
 * command handler deadlocks — PI cannot tear down the current session
 * until our handler returns, but awaiting newSession here prevents us
 * from returning. Prior versions used `Promise.race(newSession, timeout)`
 * which hung every `/tff next` post-plan in the wild (session.lock stayed
 * held, pending-phase-message.txt stashed, no new jsonl, no timeout ever
 * firing because the event loop was blocked by the unresolved handler
 * promise).
 *
 * Trade-off: we cannot surface newSession's cancellation/failure to the
 * user directly — the current session is gone by the time newSession
 * resolves. Failure recovery flows through `/tff doctor`, which reads
 * the orphaned session.lock + pending-phase-message.txt.
 */
export async function runPhaseWithFreshContext(
	opts: FreshContextOpts,
): Promise<PhasePrepareResult> {
	const { phaseModule, phaseCtx, cmdCtx, phase } = opts;

	if (!cmdCtx) {
		return {
			success: false,
			retry: true,
			error:
				"Fresh context unavailable — no command context stashed. Try running the command again.",
		};
	}

	acquireLock(phaseCtx.root, { phase, sliceId: phaseCtx.slice.id });

	// Run prepare in the LIVE session — db and pi are valid here.
	let prepareResult: PhasePrepareResult;
	try {
		prepareResult = await phaseModule.prepare(phaseCtx);
	} catch (err) {
		releaseLock(phaseCtx.root);
		return {
			success: false,
			retry: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// If prepare failed or produced no message, we're done — no fresh
	// session needed, release the lock and return.
	if (!prepareResult.success || !prepareResult.message) {
		releaseLock(phaseCtx.root);
		return prepareResult;
	}

	// Stash the message on disk (module-level state is not guaranteed to
	// survive the extension reload triggered by newSession). The
	// session_start handler for the new session reads it back.
	writePendingMessage(phaseCtx.root, prepareResult.message);

	// Release the lock before scheduling — the new session starts without
	// holding a lock (acquireLock happens only inside command handlers),
	// and /tff doctor handles any rare orphaned state.
	releaseLock(phaseCtx.root);

	// Schedule newSession to fire AFTER this handler returns. void discards
	// the promise: we intentionally do not await it (see docblock).
	setImmediate(() => {
		void cmdCtx.newSession();
	});

	return { success: true, retry: false };
}
