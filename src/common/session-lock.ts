import {
	constants,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
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
	return join(root, ".pi", ".tff", LOCK_FILE);
}

export function acquireLock(root: string, opts: { phase: Phase; sliceId: string }): void {
	const lock: SessionLock = {
		phase: opts.phase,
		sliceId: opts.sliceId,
		pid: process.pid,
		timestamp: new Date().toISOString(),
	};
	const json = JSON.stringify(lock, null, 2);
	const p = lockPath(root);

	// Atomic create — fails if file exists (O_EXCL) or is a symlink (O_NOFOLLOW).
	// Prevents TOCTOU races and symlink attacks that could redirect writes.
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
	let fd: number;
	try {
		fd = openSync(p, flags, 0o600);
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code: string }).code === "EEXIST"
		) {
			const existing = readLock(root);
			if (existing && isLockStale(existing)) {
				// Dead process — safe to overwrite.
				unlinkSync(p);
				fd = openSync(p, flags, 0o600);
			} else {
				throw new Error(
					`Cannot acquire lock: existing lock is held by PID ${existing?.pid ?? "unknown"}. Run \`/tff recover dismiss\` to clear it manually if the process has exited.`,
				);
			}
		} else {
			throw err;
		}
	}
	try {
		writeSync(fd, json);
	} finally {
		closeSync(fd);
	}
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
