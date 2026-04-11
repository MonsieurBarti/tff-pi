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

export interface PhaseResult {
	success: boolean;
	retry: boolean;
	error?: string;
	feedback?: string;
}

export interface PhaseModule {
	run(ctx: PhaseContext): Promise<PhaseResult>;
}

const NEW_SESSION_TIMEOUT_MS = 30_000;

interface FreshContextOpts {
	phaseModule: PhaseModule;
	phaseCtx: PhaseContext;
	cmdCtx: ExtensionCommandContext | null;
	phase: Phase;
	timeoutMs?: number;
}

export async function runPhaseWithFreshContext(opts: FreshContextOpts): Promise<PhaseResult> {
	const { phaseModule, phaseCtx, cmdCtx, phase, timeoutMs = NEW_SESSION_TIMEOUT_MS } = opts;

	if (!cmdCtx) {
		return {
			success: false,
			retry: true,
			error:
				"Fresh context unavailable — no command context stashed. Try running the command again.",
		};
	}

	// Acquire lock before session creation
	acquireLock(phaseCtx.root, { phase, sliceId: phaseCtx.slice.id });

	try {
		// Create fresh session with timeout
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

		// Run the phase
		return await phaseModule.run(phaseCtx);
	} catch (err) {
		return {
			success: false,
			retry: false,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		releaseLock(phaseCtx.root);
	}
}
