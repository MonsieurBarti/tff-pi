import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { acquireLock, releaseLock } from "./session-lock.js";
import type { Settings } from "./settings.js";
import type { Phase, Slice } from "./types.js";

/**
 * Hook used by `runPhaseWithFreshContext` to stash the phase message for the
 * next fresh session. Injected by the extension entry point to avoid circular
 * imports between `phase.ts` and `index.ts`.
 */
let setPendingMessageHook: ((message: string | null) => void) | null = null;

export function setPendingMessageDelivery(fn: ((message: string | null) => void) | null): void {
	setPendingMessageHook = fn;
}

export interface PhaseContext {
	pi: ExtensionAPI;
	db: Database.Database;
	root: string;
	slice: Slice;
	milestoneNumber: number;
	settings: Settings;
	feedback?: string;
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

const NEW_SESSION_TIMEOUT_MS = 30_000;

interface FreshContextOpts {
	phaseModule: PhaseModule;
	phaseCtx: PhaseContext;
	cmdCtx: ExtensionCommandContext | null;
	phase: Phase;
	timeoutMs?: number;
}

export async function runPhaseWithFreshContext(
	opts: FreshContextOpts,
): Promise<PhasePrepareResult> {
	const { phaseModule, phaseCtx, cmdCtx, phase, timeoutMs = NEW_SESSION_TIMEOUT_MS } = opts;

	if (!cmdCtx) {
		return {
			success: false,
			retry: true,
			error:
				"Fresh context unavailable — no command context stashed. Try running the command again.",
		};
	}

	acquireLock(phaseCtx.root, { phase, sliceId: phaseCtx.slice.id });

	try {
		// Run prepare in the LIVE session — db and pi are valid here.
		let prepareResult: PhasePrepareResult;
		try {
			prepareResult = await phaseModule.prepare(phaseCtx);
		} catch (err) {
			return {
				success: false,
				retry: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		// If prepare failed or produced no message, we're done — no fresh session needed.
		if (!prepareResult.success || !prepareResult.message) {
			return prepareResult;
		}

		// Stash the message so it's delivered by the session_start handler
		// after the new session's runtime is bound. Calling sendMessage on
		// the old pi before session_start fires goes to a non-existent queue.
		const message = prepareResult.message;
		if (setPendingMessageHook) {
			setPendingMessageHook(message);
		}

		const sessionPromise = cmdCtx.newSession();
		const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
			setTimeout(() => resolve({ cancelled: true }), timeoutMs);
		});

		const result = await Promise.race([sessionPromise, timeoutPromise]);

		if (result.cancelled) {
			// Clear stashed message — no session to deliver it to.
			if (setPendingMessageHook) {
				setPendingMessageHook(null);
			}
			return {
				success: false,
				retry: true,
				error: "Session creation timed out or was cancelled. Try again.",
			};
		}

		// Message delivery happens in the session_start handler.
		return { success: true, retry: false };
	} finally {
		releaseLock(phaseCtx.root);
	}
}
