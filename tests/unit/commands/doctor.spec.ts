import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALLED_THRESHOLD_MS, handleDoctor } from "../../../src/commands/doctor.js";
import { initMilestoneDir, initSliceDir, initTffDirectory } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updatePhaseRun,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

describe("handleDoctor", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("reports OK when no project exists", () => {
		const freshDb = openDatabase(":memory:");
		applyMigrations(freshDb);
		const report = handleDoctor(freshDb);
		expect(report.ok).toBe(true);
		expect(report.stalledPhases).toHaveLength(0);
		expect(report.message).toMatch(/No project/);
	});

	it("reports OK when no phase_run rows exist", () => {
		const report = handleDoctor(db);
		expect(report.ok).toBe(true);
		expect(report.stalledPhases).toHaveLength(0);
		expect(report.message).toMatch(/no stalled phases/);
	});

	it("ignores recently started phases", () => {
		const now = Date.now();
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - 60_000).toISOString(), // 1 min ago
		});
		const report = handleDoctor(db, { now });
		expect(report.ok).toBe(true);
		expect(report.stalledPhases).toHaveLength(0);
	});

	it("ignores completed phases older than threshold", () => {
		const now = Date.now();
		const id = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - STALLED_THRESHOLD_MS * 2).toISOString(),
		});
		updatePhaseRun(db, id, { status: "completed", finishedAt: new Date(now).toISOString() });
		const report = handleDoctor(db, { now });
		expect(report.ok).toBe(true);
		expect(report.stalledPhases).toHaveLength(0);
	});

	it("flags a phase still 'started' past threshold", () => {
		const now = Date.now();
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - STALLED_THRESHOLD_MS - 60_000).toISOString(),
		});
		const report = handleDoctor(db, { now });
		expect(report.ok).toBe(false);
		expect(report.stalledPhases).toHaveLength(1);
		expect(must(report.stalledPhases[0]).phase).toBe("plan");
		expect(must(report.stalledPhases[0]).sliceLabel).toBe("M01-S01");
		expect(report.message).toMatch(/stalled/);
		expect(report.message).toMatch(/\/tff plan M01-S01/);
	});

	it("recovers stalled phase_runs when --recover is passed", () => {
		const now = Date.now();
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - STALLED_THRESHOLD_MS - 60_000).toISOString(),
		});
		const report = handleDoctor(db, { now, recover: true });
		expect(report.message).toMatch(/recovered 1/);

		// Subsequent run should show no stalled phases (all marked abandoned).
		const after = handleDoctor(db, { now });
		expect(after.stalledPhases).toHaveLength(0);
	});
});

describe("handleDoctor — drift reconcile", () => {
	let db: Database.Database;
	let sliceId: string;
	let root: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-doctor-drift-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		initSliceDir(root, 1, 1);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("detects a drifted slice.status without reconciling (no --recover)", () => {
		// slice.status starts as "created" (default after insert).
		// Seed execute/started phase_run so computeSliceStatus returns "executing".
		// The slice.status in DB is "created" (default), so drift is created → executing.
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const sliceBefore = must(getSlice(db, sliceId));
		expect(sliceBefore.status).toBe("created");

		const report = handleDoctor(db, { root });

		expect(report.ok).toBe(false);
		expect(report.drifts).toHaveLength(1);
		const drift = must(report.drifts[0]);
		expect(drift.sliceLabel).toBe("M01-S01");
		expect(drift.from).toBe("created");
		expect(drift.to).toBe("executing");

		// DB must NOT be updated without --recover
		const sliceAfter = must(getSlice(db, sliceId));
		expect(sliceAfter.status).toBe("created");

		expect(report.message).toMatch(/Detected 1 slice\(s\)/);
		expect(report.message).toMatch(/--recover/);
	});

	it("detects and reconciles a drifted slice.status with --recover", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const report = handleDoctor(db, { root, recover: true });

		expect(report.ok).toBe(true);
		expect(report.drifts).toHaveLength(1);

		// DB should be updated after reconcile
		const sliceAfter = must(getSlice(db, sliceId));
		expect(sliceAfter.status).toBe("executing");

		expect(report.message).toMatch(/Reconciled 1 slice\(s\)/);
	});

	it("skips drift check if no root provided", () => {
		// Even with a started phase_run that would cause drift, no root means no check
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const report = handleDoctor(db, {});
		expect(report.drifts).toEqual([]);
	});
});
