import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
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
import { hashEvent } from "../../../src/common/event-log.js";
import { validateCommandPreconditions } from "../../../src/common/preconditions.js";

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tff-prec-"));
	mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
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

describe("validateCommandPreconditions — write-pr", () => {
	test("ok when slice is verifying with active verify phase_run", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "verifying");
		insertPhaseRun(db, { sliceId: sId, phase: "verify", status: "started", startedAt: "t0" });

		const result = validateCommandPreconditions(db, root, "write-pr", { sliceId: sId });
		expect(result).toEqual({ ok: true });
	});

	test("fails when slice is not verifying", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "executing");

		const result = validateCommandPreconditions(db, root, "write-pr", { sliceId: sId });
		expect(result.ok).toBe(false);
	});
});

describe("validateCommandPreconditions — ship-changes write-pr gate", () => {
	test("fails when no write-pr event exists in log for the slice", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "shipping");
		insertPhaseRun(db, { sliceId: sId, phase: "ship", status: "started", startedAt: "t0" });

		const result = validateCommandPreconditions(db, root, "ship-changes", { sliceId: sId });
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/write-pr/);
	});

	test("ok when write-pr event exists in log for the slice", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "shipping");
		insertPhaseRun(db, { sliceId: sId, phase: "ship", status: "started", startedAt: "t0" });

		// Write a write-pr event directly to the log
		const logPath = join(root, ".pi/.tff/event-log.jsonl");
		const event = {
			v: 2,
			cmd: "write-pr",
			params: { sliceId: sId },
			ts: new Date().toISOString(),
			hash: hashEvent("write-pr", { sliceId: sId }),
			actor: "agent",
			session_id: "s",
		};
		appendFileSync(logPath, `${JSON.stringify(event)}\n`);

		const result = validateCommandPreconditions(db, root, "ship-changes", { sliceId: sId });
		expect(result).toEqual({ ok: true });
	});
});

describe("validateCommandPreconditions — ship-merged idempotency", () => {
	function seedShippingSlice() {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		insertPhaseRun(db, { sliceId: sId, phase: "ship", status: "started", startedAt: "t0" });
		const tId = insertTask(db, { sliceId: sId, number: 1, title: "T1" });
		updateTaskStatus(db, tId, "closed");
		return { db, root, sId };
	}

	test("accepts slice in 'shipping' (first-pass commit)", () => {
		const { db, root, sId } = seedShippingSlice();
		forceSliceStatus(db, sId, "shipping");
		const result = validateCommandPreconditions(db, root, "ship-merged", { sliceId: sId });
		expect(result).toEqual({ ok: true });
	});

	test("accepts slice already in 'closed' (finalizeMergedSlice override ran before commitCommand)", () => {
		// Reproduces the bug: `tff_ship_merged` errored with
		// "Slice must be in 'shipping' (current: 'closed')" because
		// finalizeMergedSlice overrides status to closed before
		// commitCommand("ship-merged") journals the projection.
		const { db, root, sId } = seedShippingSlice();
		forceSliceStatus(db, sId, "closed");
		const result = validateCommandPreconditions(db, root, "ship-merged", { sliceId: sId });
		expect(result).toEqual({ ok: true });
	});

	test("rejects slice in any other status (e.g. 'reviewing')", () => {
		const { db, root, sId } = seedShippingSlice();
		forceSliceStatus(db, sId, "reviewing");
		const result = validateCommandPreconditions(db, root, "ship-merged", { sliceId: sId });
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/shipping.*closed/);
	});

	test("rejects double-call detected via completed phase_run", () => {
		// After a full ship-merged cycle, phase_run.ship.status = 'completed'.
		// A second call must fail even though slice.status is still 'closed'.
		const { db, root, sId } = seedShippingSlice();
		forceSliceStatus(db, sId, "closed");
		db.prepare(
			"UPDATE phase_run SET status = 'completed' WHERE slice_id = ? AND phase = 'ship'",
		).run(sId);
		const result = validateCommandPreconditions(db, root, "ship-merged", { sliceId: sId });
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/ship.*phase_run/);
	});
});
