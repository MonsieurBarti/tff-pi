import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	updateTaskStatus,
} from "../../../src/common/db.js";
import { validateCommandPreconditions } from "../../../src/common/preconditions.js";

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tff-prec-"));
	mkdirSync(join(root, ".tff"), { recursive: true });
	return root;
}

function seeded() {
	const db = new Database(":memory:");
	applyMigrations(db);
	const root = tempRoot();
	return { db, root };
}

/** Direct DB helper to force a slice to a given status (bypasses state machine). */
function forceSliceStatus(db: Database.Database, sliceId: string, status: string): void {
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(status, sliceId);
}

describe("validateCommandPreconditions — execute-done", () => {
	test("returns ok when all tasks are closed", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "executing");
		insertPhaseRun(db, { sliceId: sId, phase: "execute", status: "started", startedAt: "t0" });
		const t1 = insertTask(db, { sliceId: sId, number: 1, title: "T1" });
		updateTaskStatus(db, t1, "closed");
		const result = validateCommandPreconditions(db, root, "execute-done", { sliceId: sId });
		expect(result).toEqual({ ok: true });
	});

	test("returns failure when 1 task is open", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "executing");
		insertPhaseRun(db, { sliceId: sId, phase: "execute", status: "started", startedAt: "t0" });
		insertTask(db, { sliceId: sId, number: 1, title: "T1" }); // default status='open'
		const result = validateCommandPreconditions(db, root, "execute-done", { sliceId: sId });
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/task/i);
	});
});

describe("validateCommandPreconditions — write-verification", () => {
	test("returns ok when slice is verifying with verify phase_run started", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "verifying");
		insertPhaseRun(db, { sliceId: sId, phase: "verify", status: "started", startedAt: "t0" });
		const t1 = insertTask(db, { sliceId: sId, number: 1, title: "T1" });
		updateTaskStatus(db, t1, "closed");
		const result = validateCommandPreconditions(db, root, "write-verification", { sliceId: sId });
		expect(result).toEqual({ ok: true });
	});

	test("returns failure when slice is in executing (wrong status)", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "executing");
		const result = validateCommandPreconditions(db, root, "write-verification", { sliceId: sId });
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/verifying/);
	});
});

describe("validateCommandPreconditions — transition", () => {
	test("returns failure for executing→verifying with open tasks", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "executing");
		insertTask(db, { sliceId: sId, number: 1, title: "T1" }); // open
		const result = validateCommandPreconditions(db, root, "transition", {
			sliceId: sId,
			to: "verifying",
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/task/i);
	});

	test("returns ok for executing→verifying with all tasks closed", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "executing");
		const t1 = insertTask(db, { sliceId: sId, number: 1, title: "T1" });
		updateTaskStatus(db, t1, "closed");
		const result = validateCommandPreconditions(db, root, "transition", {
			sliceId: sId,
			to: "verifying",
		});
		expect(result).toEqual({ ok: true });
	});
});

describe("validateCommandPreconditions — complete-milestone-merged", () => {
	test("returns failure when milestone is not in completing", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		// milestone starts in 'created' status
		const result = validateCommandPreconditions(db, root, "complete-milestone-merged", {
			milestoneId: mId,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/completing/);
	});
});

describe("validateCommandPreconditions — unknown command", () => {
	test("returns ok for unknown command (let projectCommand handle it)", () => {
		const { db, root } = seeded();
		const result = validateCommandPreconditions(db, root, "this-command-does-not-exist", {});
		expect(result).toEqual({ ok: true });
	});
});
