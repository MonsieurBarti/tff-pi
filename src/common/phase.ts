import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { acquireLock, releaseLock } from "./session-lock.js";
import type { Settings } from "./settings.js";
import type { Phase, Slice } from "./types.js";

function debugLog(root: string, event: string, details?: Record<string, unknown>): void {
	try {
		const dir = join(root, ".tff", "logs");
		mkdirSync(dir, { recursive: true });
		const entry = `${new Date().toISOString()} [${event}] ${JSON.stringify(details ?? {})}\n`;
		appendFileSync(join(dir, "phase-handoff.log"), entry, "utf-8");
	} catch {
		// best effort
	}
}

const PENDING_MESSAGE_FILE = "pending-phase-message.txt";

function pendingMessagePath(root: string): string {
	return join(root, ".tff", PENDING_MESSAGE_FILE);
}

export function writePendingMessage(root: string, message: string): void {
	const p = pendingMessagePath(root);
	mkdirSync(join(root, ".tff"), { recursive: true });
	writeFileSync(p, message, "utf-8");
	debugLog(root, "pending-message-written", { bytes: message.length });
}

export function readPendingMessage(root: string): string | null {
	const p = pendingMessagePath(root);
	if (!existsSync(p)) return null;
	try {
		const content = readFileSync(p, "utf-8");
		return content;
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

export { debugLog };

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

		// Stash the message on disk (module state may not survive extension reload)
		// AND via in-memory hook (belt + suspenders). The session_start handler
		// for the new session reads from disk first, then falls back to memory.
		const message = prepareResult.message;
		writePendingMessage(phaseCtx.root, message);
		if (setPendingMessageHook) {
			setPendingMessageHook(message);
		}
		debugLog(phaseCtx.root, "about-to-newsession", {
			phase,
			sliceId: phaseCtx.slice.id,
			messageBytes: message.length,
		});

		const sessionPromise = cmdCtx.newSession();
		const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
			setTimeout(() => resolve({ cancelled: true }), timeoutMs);
		});

		const result = await Promise.race([sessionPromise, timeoutPromise]);
		debugLog(phaseCtx.root, "newsession-returned", { cancelled: result.cancelled });

		if (result.cancelled) {
			clearPendingMessage(phaseCtx.root);
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
