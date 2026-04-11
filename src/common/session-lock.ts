import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Phase } from "./types.js";

export interface SessionLock {
	phase: Phase;
	sliceId: string;
	pid: number;
	timestamp: string;
}

const LOCK_FILE = "session.lock";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

function lockPath(root: string): string {
	return join(root, ".tff", LOCK_FILE);
}

export function acquireLock(root: string, opts: { phase: Phase; sliceId: string }): void {
	const lock: SessionLock = {
		phase: opts.phase,
		sliceId: opts.sliceId,
		pid: process.pid,
		timestamp: new Date().toISOString(),
	};
	writeFileSync(lockPath(root), JSON.stringify(lock, null, 2), "utf-8");
}

export function releaseLock(root: string): void {
	const p = lockPath(root);
	if (existsSync(p)) {
		unlinkSync(p);
	}
}

export function readLock(root: string): SessionLock | null {
	const p = lockPath(root);
	if (!existsSync(p)) return null;
	try {
		const raw = readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw);
		if (
			typeof parsed.phase === "string" &&
			typeof parsed.sliceId === "string" &&
			typeof parsed.pid === "number" &&
			typeof parsed.timestamp === "string"
		) {
			return parsed as SessionLock;
		}
		return null;
	} catch {
		return null;
	}
}

export function isLockStale(lock: SessionLock): boolean {
	// Check age first — guard against PID recycling
	const age = Date.now() - new Date(lock.timestamp).getTime();
	if (age > STALE_THRESHOLD_MS) return true;

	// Check if PID is alive
	try {
		process.kill(lock.pid, 0);
		return false;
	} catch {
		return true;
	}
}
