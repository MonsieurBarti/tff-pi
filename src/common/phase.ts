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

/**
 * Synchronous on purpose — the disk write must complete before we `await
 * cmdCtx.newSession()` below, since the new session's `session_start`
 * handler reads this file and any async race would leave it empty.
 */
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
	/** Kept for API back-compat; not honored. */
	timeoutMs?: number;
}

/**
 * Runs a phase's prepare() in the current session, opens a fresh PI session,
 * and delivers the prepared prompt autonomously so the agent starts working
 * without user input.
 *
 * Pattern (mirrors gsd-pi `auto/run-unit.ts` and `auto-direct-dispatch.ts`):
 *   1. `await cmdCtx.newSession()` — swap to a clean session. Awaiting works
 *      because we're still inside the outer command-handler coroutine; PI
 *      tears down the old session and rebinds the extension during the await.
 *   2. `phaseCtx.pi.sendMessage({customType, content, display}, {triggerTurn: true})`
 *      — deliver + kick a turn on the now-idle fresh session. `triggerTurn:
 *      true` is the piece that makes the agent auto-process; SessionManager
 *      `appendMessage` or plain `sendUserMessage` isn't enough.
 *
 * Disk-stashed message is a crash-recovery backstop (for /tff doctor).
 * On the happy path we clear it after delivery; on cancel we leave it.
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

	const message = prepareResult.message;

	// Stash on disk as a crash-recovery backstop before we try to switch.
	writePendingMessage(phaseCtx.root, message);

	// Release the lock before awaiting newSession — the new session must
	// start without holding our lock.
	releaseLock(phaseCtx.root);

	// Await newSession with a LIVE cmdCtx (no stale-closure freeze). The NEW
	// session's `session_start` hook (registerLifecycleHooks in lifecycle.ts)
	// picks up the disk-stashed message and delivers it via its fresh `pi`
	// handle — the old session's `pi` captured in phaseCtx becomes stale
	// the moment newSession returns (it routes to the disposed old runtime).
	const { cancelled } = await cmdCtx.newSession();

	if (cancelled) {
		// Leave the disk stash in place; /tff doctor can recover.
		return {
			success: false,
			retry: true,
			error: "New session was cancelled by a session_before_switch handler",
		};
	}

	// Do NOT call phaseCtx.pi.sendMessage here — phaseCtx.pi is stale.
	// The new session's session_start handler delivers the message.

	return { success: true, retry: false };
}
