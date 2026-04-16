import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeRecovery } from "../../../src/commands/recover.js";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updatePhaseRun,
} from "../../../src/common/db.js";
import { gitEnv } from "../../../src/common/git.js";
import { acquireLock, readLock } from "../../../src/common/session-lock.js";

function makeMockPi(): ExtensionAPI {
	return {
		events: {
			emit: vi.fn(),
			on: vi.fn(),
			once: vi.fn(),
			off: vi.fn(),
		},
		sendUserMessage: vi.fn(),
		commands: {
			executeCommand: vi.fn(),
		},
	} as unknown as ExtensionAPI;
}

describe("recover command", () => {
	let root: string;
	let db: Database.Database;
	let savedEnv: Record<string, string | undefined> = {};
	let mockPi: ExtensionAPI;

	beforeEach(() => {
		mockPi = makeMockPi();
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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(
			db,
			root,
			{
				action: "dismiss",
				sliceId: sId,
				milestoneNumber: 1,
			},
			mockPi,
		);

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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(
			db,
			root,
			{
				action: "resume",
				sliceId: sId,
				milestoneNumber: 1,
			},
			mockPi,
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("/tff execute M01-S01");
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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);
		acquireLock(root, { phase: "execute", sliceId: sId });

		// Create artifacts to support reconciliation after the skip
		const planDir = join(root, ".tff/milestones/M01/slices/M01-S01");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "PLAN.md"), "plan");

		// Insert completed execute phase run so reconcile sees a path forward to verify
		const prId = insertPhaseRun(db, {
			sliceId: sId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, prId, {
			status: "completed",
			finishedAt: new Date().toISOString(),
		});

		const result = executeRecovery(
			db,
			root,
			{
				action: "skip",
				sliceId: sId,
				milestoneNumber: 1,
			},
			mockPi,
		);

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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);
		acquireLock(root, { phase: "execute", sliceId: sId });

		const result = executeRecovery(
			db,
			root,
			{
				action: "rollback",
				sliceId: sId,
				milestoneNumber: 1,
			},
			mockPi,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("No checkpoint");
		expect(readLock(root)).toBeNull();
	});
});
