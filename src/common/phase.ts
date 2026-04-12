import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
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

		// Create fresh session — no setup callback. After newSession() resolves,
		// the shared ExtensionRuntime has been rebound to the new session's actions,
		// so pi.sendMessage() on the old facade routes to the new session.
		// This mirrors GSD-2's exact pattern (auto/run-unit.ts).
		const message = prepareResult.message;
		const sessionPromise = cmdCtx.newSession();
		const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
			setTimeout(() => resolve({ cancelled: true }), timeoutMs);
		});

		const result = await Promise.race([sessionPromise, timeoutPromise]);

		if (result.cancelled) {
			return {
				success: false,
				retry: true,
				error: "Session creation timed out or was cancelled. Try again.",
			};
		}

		// Send the phase prompt as a custom message with triggerTurn:true to
		// kick off the agent loop immediately in the fresh session.
		phaseCtx.pi.sendMessage(
			{
				customType: "tff-phase",
				content: message,
				display: true,
			},
			{ triggerTurn: true },
		);

		return { success: true, retry: false };
	} finally {
		releaseLock(phaseCtx.root);
	}
}
