import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import type { FffBridge } from "./fff-integration.js";
import { acquireLock, releaseLock } from "./session-lock.js";
import type { Settings } from "./settings.js";
import type { Phase, Slice } from "./types.js";

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
 * Runs a phase's prepare() in the current session, then opens a fresh PI
 * session and delivers the prepared prompt as the first user message, which
 * triggers the agent turn automatically.
 *
 * Two-step handoff:
 *   1. `await cmdCtx.newSession()` — swaps to a clean session. Pi rebinds
 *      the extension instance during the await; module-level state in this
 *      extension is gone after resolve. Re-establish anything you need in
 *      the `session_start` hook.
 *   2. `phaseCtx.pi.sendUserMessage(message)` — `pi` is the ExtensionAPI
 *      handle that survives the rebind. `sendUserMessage` always triggers
 *      a new turn (unlike `SessionManager.appendMessage` inside a `setup`
 *      callback, which only pre-populates history and leaves the agent
 *      waiting for user input).
 *
 * Earlier versions stashed the message to disk and fired newSession via
 * `setImmediate` to avoid a presumed deadlock — that workaround caused
 * silent no-ops when the captured ExtensionRunner was torn down before
 * setImmediate fired. The `setup` callback variant that followed it left
 * the agent waiting because `appendMessage` doesn't trigger a turn.
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

	if (!prepareResult.success || !prepareResult.message) {
		releaseLock(phaseCtx.root);
		return prepareResult;
	}

	// Release the lock before awaiting newSession — the new session must
	// start without holding our lock.
	releaseLock(phaseCtx.root);

	const message = prepareResult.message;
	const { cancelled } = await cmdCtx.newSession();

	if (cancelled) {
		return {
			success: false,
			retry: true,
			error: "New session was cancelled by a session_before_switch handler",
		};
	}

	// Delivers + triggers a turn. Use pi (ExtensionAPI, survives rebind)
	// rather than cmdCtx (ExtensionCommandContext, dies with the old session).
	phaseCtx.pi.sendUserMessage(message);

	return { success: true, retry: false };
}
