import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireLock,
	isLockStale,
	readLock,
	releaseLock,
} from "../../../src/common/session-lock.js";

describe("session-lock", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `tff-lock-test-${Date.now()}`);
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("acquireLock writes a lock file with expected fields", () => {
		acquireLock(root, { phase: "execute", sliceId: "slice-1" });
		const lock = readLock(root);
		expect(lock).not.toBeNull();
		expect(lock?.phase).toBe("execute");
		expect(lock?.sliceId).toBe("slice-1");
		expect(lock?.pid).toBe(process.pid);
		expect(typeof lock?.timestamp).toBe("string");
	});

	it("releaseLock removes the lock file", () => {
		acquireLock(root, { phase: "verify", sliceId: "slice-2" });
		releaseLock(root);
		expect(readLock(root)).toBeNull();
	});

	it("readLock returns null when no lock exists", () => {
		expect(readLock(root)).toBeNull();
	});

	it("readLock returns null for malformed JSON", () => {
		writeFileSync(join(root, ".pi", ".tff", "session.lock"), "not json", "utf-8");
		expect(readLock(root)).toBeNull();
	});

	it("isLockStale returns false for current PID", () => {
		acquireLock(root, { phase: "plan", sliceId: "s1" });
		const lock = readLock(root);
		expect(lock).not.toBeNull();
		if (lock) {
			expect(isLockStale(lock)).toBe(false);
		}
	});

	it("isLockStale returns true for non-existent PID", () => {
		const lock = {
			phase: "execute" as const,
			sliceId: "s1",
			pid: 999999999,
			timestamp: new Date().toISOString(),
		};
		expect(isLockStale(lock)).toBe(true);
	});

	it("isLockStale returns true for lock older than 24 hours", () => {
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		const lock = {
			phase: "execute" as const,
			sliceId: "s1",
			pid: process.pid,
			timestamp: old,
		};
		expect(isLockStale(lock)).toBe(true);
	});

	it("acquireLock fails atomically when a fresh lock exists", () => {
		acquireLock(root, { phase: "execute", sliceId: "slice-1" });
		expect(() => acquireLock(root, { phase: "verify", sliceId: "slice-2" })).toThrow(
			/Cannot acquire lock/,
		);
	});

	it("acquireLock replaces stale lock atomically", () => {
		const staleLock = {
			phase: "execute",
			sliceId: "old-slice",
			pid: process.pid,
			timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
		};
		writeFileSync(join(root, ".pi", ".tff", "session.lock"), JSON.stringify(staleLock), "utf-8");

		acquireLock(root, { phase: "plan", sliceId: "new-slice" });
		const current = readLock(root);
		expect(current?.sliceId).toBe("new-slice");
	});
});
