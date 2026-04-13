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
 * Runs a phase's prepare() in the current session, then awaits a fresh PI
 * session that delivers the prepared prompt as its first user message via
 * the `setup` callback.
 *
 * Modeled on `pi-coding-agent/examples/extensions/handoff.ts` — the canonical
 * pattern is `await ctx.newSession({ parentSession, setup })` directly inside
 * a command handler. Pi handles teardown of the current session and binding
 * of the new one during the await; module-level state in this extension is
 * gone after newSession resolves, so re-establish anything you need in the
 * `session_start` hook.
 *
 * Earlier versions stashed the message to disk and fired newSession via
 * `setImmediate` to avoid a presumed deadlock — that workaround is no longer
 * needed and caused silent no-ops when the captured ExtensionRunner was
 * torn down before setImmediate fired.
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
	const { cancelled } = await cmdCtx.newSession({
		setup: async (sm) => {
			await sm.appendMessage({ role: "user", content: message, timestamp: Date.now() });
		},
	});

	if (cancelled) {
		return {
			success: false,
			retry: true,
			error: "New session was cancelled by a session_before_switch handler",
		};
	}

	return { success: true, retry: false };
}
