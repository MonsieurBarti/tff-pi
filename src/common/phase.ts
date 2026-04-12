import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
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

		// Stash the message on disk (module-level state is not guaranteed to
		// survive the extension reload triggered by newSession). The
		// session_start handler for the new session reads it back.
		const message = prepareResult.message;
		writePendingMessage(phaseCtx.root, message);

		const sessionPromise = cmdCtx.newSession();
		const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
			setTimeout(() => resolve({ cancelled: true }), timeoutMs);
		});

		const result = await Promise.race([sessionPromise, timeoutPromise]);

		if (result.cancelled) {
			clearPendingMessage(phaseCtx.root);
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
