import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeRecovery } from "../../../src/commands/recover.js";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { gitEnv } from "../../../src/common/git.js";
import { acquireLock, readLock } from "../../../src/common/session-lock.js";

describe("recover command", () => {
	let root: string;
	let db: Database.Database;
	let savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		root = join(tmpdir(), `tff-recover-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".tff"), { recursive: true });
		execFileSync("git", ["init"], { cwd: root, env: gitEnv() });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, env: gitEnv() });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root, env: gitEnv() });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root, env: gitEnv() });
		db = openDatabase(join(root, ".tff", "state.db"));
		applyMigrations(db);
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
		savedEnv = {};
	});

	it("dismiss clears lock without changing state", () => {
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			projectId: pId,
			number: 1,
			name: "M",
			branch: "milestone/M01",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		updateSliceStatus(db, sId, "executing");
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(db, root, {
			action: "dismiss",
			sliceId: sId,
			milestoneNumber: 1,
		});

		expect(result.success).toBe(true);
		expect(readLock(root)).toBeNull();
		const after = getSlice(db, sId);
		expect(after?.status).toBe("executing");
	});

	it("resume clears lock and suggests next command", () => {
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			projectId: pId,
			number: 1,
			name: "M",
			branch: "milestone/M01",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		updateSliceStatus(db, sId, "executing");
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(db, root, {
			action: "resume",
			sliceId: sId,
			milestoneNumber: 1,
		});

		expect(result.success).toBe(true);
		expect(result.message).toContain("execute");
		expect(readLock(root)).toBeNull();
	});

	it("skip fast-forwards DB status", () => {
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			projectId: pId,
			number: 1,
			name: "M",
			branch: "milestone/M01",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		updateSliceStatus(db, sId, "executing");
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(db, root, {
			action: "skip",
			sliceId: sId,
			milestoneNumber: 1,
		});

		expect(result.success).toBe(true);
		const after = getSlice(db, sId);
		expect(after?.status).toBe("verifying");
		expect(readLock(root)).toBeNull();
	});

	it("rollback without worktree returns error gracefully", () => {
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			projectId: pId,
			number: 1,
			name: "M",
			branch: "milestone/M01",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		updateSliceStatus(db, sId, "executing");
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(db, root, {
			action: "rollback",
			sliceId: sId,
			milestoneNumber: 1,
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain("No checkpoint");
		expect(readLock(root)).toBeNull();
	});
});
