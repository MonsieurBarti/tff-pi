import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	STALLED_THRESHOLD_MS,
	buildShadowDb,
	checkInvariantSweep,
	checkLogProjectionDrift,
	handleDoctor,
} from "../../../src/commands/doctor.js";
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
import { appendCommand } from "../../../src/common/event-log.js";
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

	it("recovers stalled phase_runs when --repair is passed", () => {
		const now = Date.now();
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - STALLED_THRESHOLD_MS - 60_000).toISOString(),
		});
		const report = handleDoctor(db, { now, repair: true });
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

	it("detects a drifted slice.status without reconciling (no --repair)", () => {
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

		// DB must NOT be updated without --repair
		const sliceAfter = must(getSlice(db, sliceId));
		expect(sliceAfter.status).toBe("created");

		expect(report.message).toMatch(/Detected 1 slice\(s\)/);
		expect(report.message).toMatch(/--repair/);
	});

	it("detects and reconciles a drifted slice.status with --repair", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const report = handleDoctor(db, { root, repair: true });

		// ok is false: live DB has a phase_run not present in the event log → log drift
		// cannot be auto-repaired, so ok stays false even when slice drift is reconciled.
		expect(report.ok).toBe(false);
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

describe("buildShadowDb", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-shadow-test-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns an empty projection when event-log does not exist", () => {
		const shadow = buildShadowDb(root);
		const rows = shadow.prepare("SELECT * FROM project").all();
		expect(rows).toHaveLength(0);
	});

	it("projects create-project event into shadow DB", () => {
		appendCommand(root, "create-project", { id: "p1", name: "TFF", vision: "V" });
		const shadow = buildShadowDb(root);
		const rows = shadow.prepare("SELECT * FROM project").all() as { name: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("TFF");
	});
});

describe("checkLogProjectionDrift", () => {
	let liveDb: Database.Database;
	let shadowDb: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		liveDb = openDatabase(":memory:");
		applyMigrations(liveDb);
		shadowDb = openDatabase(":memory:");
		applyMigrations(shadowDb);

		insertProject(liveDb, { name: "P", vision: "V" });
		const projectId = must(getProject(liveDb)).id;
		insertMilestone(liveDb, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(liveDb, projectId)[0]).id;
		insertSlice(liveDb, { milestoneId, number: 1, title: "S" });
		sliceId = must(getSlices(liveDb, milestoneId)[0]).id;

		// Mirror structure in shadowDb
		insertProject(shadowDb, { name: "P", vision: "V" });
		const shadowProjectId = must(getProject(shadowDb)).id;
		insertMilestone(shadowDb, {
			projectId: shadowProjectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});
		const shadowMilestoneId = must(getMilestones(shadowDb, shadowProjectId)[0]).id;
		insertSlice(shadowDb, { milestoneId: shadowMilestoneId, number: 1, title: "S" });
	});

	it("returns empty when live and shadow phase_runs match", () => {
		insertPhaseRun(liveDb, {
			sliceId,
			phase: "plan",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		const shadowSliceId = must(
			getSlices(shadowDb, must(getMilestones(shadowDb, must(getProject(shadowDb)).id)[0]).id)[0],
		).id;
		insertPhaseRun(shadowDb, {
			sliceId: shadowSliceId,
			phase: "plan",
			status: "completed",
			startedAt: new Date().toISOString(),
		});

		const drifts = checkLogProjectionDrift(liveDb, shadowDb);
		expect(drifts).toHaveLength(0);
	});

	it("detects phase_run count mismatch", () => {
		insertPhaseRun(liveDb, {
			sliceId,
			phase: "plan",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		// Shadow has no phase_runs

		const drifts = checkLogProjectionDrift(liveDb, shadowDb);
		expect(drifts).toHaveLength(1);
		expect(must(drifts[0]).field).toBe("phase_run_count");
		expect(must(drifts[0]).live).toBe("1");
		expect(must(drifts[0]).replayed).toBe("0");
	});

	it("detects phase_run status mismatch", () => {
		insertPhaseRun(liveDb, {
			sliceId,
			phase: "plan",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		const shadowSliceId = must(
			getSlices(shadowDb, must(getMilestones(shadowDb, must(getProject(shadowDb)).id)[0]).id)[0],
		).id;
		insertPhaseRun(shadowDb, {
			sliceId: shadowSliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const drifts = checkLogProjectionDrift(liveDb, shadowDb);
		expect(drifts).toHaveLength(1);
		expect(must(drifts[0]).field).toBe("phase_run_status");
		expect(must(drifts[0]).phase).toBe("plan");
		expect(must(drifts[0]).live).toBe("completed");
		expect(must(drifts[0]).replayed).toBe("started");
	});

	it("returns empty when no project in live DB", () => {
		const emptyDb = openDatabase(":memory:");
		applyMigrations(emptyDb);
		const drifts = checkLogProjectionDrift(emptyDb, shadowDb);
		expect(drifts).toHaveLength(0);
	});

	it("treats abandoned live phase_runs as non-existent for drift purposes", () => {
		// Insert an abandoned run in live — shadow has 0 runs (no event-log entry)
		insertPhaseRun(liveDb, {
			sliceId,
			phase: "plan",
			status: "abandoned",
			startedAt: new Date().toISOString(),
		});

		const drifts = checkLogProjectionDrift(liveDb, shadowDb);
		expect(drifts).toHaveLength(0);
	});
});

describe("checkInvariantSweep", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-sweep-test-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns empty when event log does not exist", () => {
		const violations = checkInvariantSweep(root);
		expect(violations).toHaveLength(0);
	});

	it("returns empty for a valid sequence of events", () => {
		const projectId = "proj-1";
		appendCommand(root, "create-project", { id: projectId, name: "P", vision: "V" });
		const milestoneId = "m-1";
		appendCommand(root, "create-milestone", {
			id: milestoneId,
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});

		const violations = checkInvariantSweep(root);
		expect(violations).toHaveLength(0);
	});

	it("records a violation when a precondition fails", () => {
		// write-plan requires slice to be in "planning" status
		// We inject a write-plan without a preceding create-slice → precondition fails
		appendCommand(root, "write-plan", { sliceId: "nonexistent-slice" });

		const violations = checkInvariantSweep(root);
		expect(violations).toHaveLength(1);
		expect(must(violations[0]).cmd).toBe("write-plan");
		expect(must(violations[0]).row).toBe(1);
		expect(must(violations[0]).reason).toBeTruthy();
	});

	it("uses injected sweepDbFactory for testing isolation", () => {
		appendCommand(root, "write-plan", { sliceId: "nonexistent-slice" });

		let factoryCalled = false;
		const factory = () => {
			factoryCalled = true;
			const db = openDatabase(":memory:");
			applyMigrations(db);
			return db;
		};

		checkInvariantSweep(root, factory);
		expect(factoryCalled).toBe(true);
	});

	it("continues projecting after a violation so subsequent checks use correct state", () => {
		const projectId = "proj-2";
		// First: valid create-project
		appendCommand(root, "create-project", { id: projectId, name: "P", vision: "V" });
		// Second: invalid write-plan (no slice) — should record violation
		appendCommand(root, "write-plan", { sliceId: "nonexistent-slice" });
		// Third: valid create-milestone (should succeed; create-project was projected)
		appendCommand(root, "create-milestone", {
			id: "m-2",
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});

		const violations = checkInvariantSweep(root);
		// Only the write-plan should be a violation
		expect(violations).toHaveLength(1);
		expect(must(violations[0]).cmd).toBe("write-plan");
	});
});

describe("handleDoctor — log drift and invariant sweep", () => {
	let db: Database.Database;
	let root: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-doctor-full-test-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("includes empty logDrifts and invariantViolations when event log is absent", () => {
		const report = handleDoctor(db, { root });
		expect(report.logDrifts).toEqual([]);
		expect(report.invariantViolations).toEqual([]);
	});

	it("includes logDrifts when shadow replay diverges from live DB", () => {
		// Seed live DB with a project + milestone + slice + phase_run
		insertProject(db, { name: "P", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "S" });
		const sliceId2 = must(getSlices(db, milestoneId)[0]).id;
		insertPhaseRun(db, {
			sliceId: sliceId2,
			phase: "plan",
			status: "completed",
			startedAt: new Date().toISOString(),
		});

		// Event log is empty → shadow has no phase_runs → drift detected
		const report = handleDoctor(db, { root });
		expect(report.logDrifts.length).toBeGreaterThan(0);
		expect(report.ok).toBe(false);
	});

	it("includes invariantViolations when event log has a bad event", () => {
		// Write an event that will fail preconditions: write-plan with no slice
		appendCommand(root, "write-plan", { sliceId: "ghost-slice" });

		const report = handleDoctor(db, { root });
		expect(report.invariantViolations.length).toBeGreaterThan(0);
		expect(must(report.invariantViolations[0]).cmd).toBe("write-plan");
		expect(report.ok).toBe(false);
	});

	it("--repair does not mutate logDrifts or invariantViolations findings", () => {
		appendCommand(root, "write-plan", { sliceId: "ghost-slice" });
		const before = handleDoctor(db, { root, repair: true });
		const after = handleDoctor(db, { root });
		// violations still present after repair — repair has no effect on them
		expect(before.invariantViolations).toHaveLength(after.invariantViolations.length);
	});

	it("message includes log drift section", () => {
		insertProject(db, { name: "P", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "S" });
		const sliceId2 = must(getSlices(db, milestoneId)[0]).id;
		insertPhaseRun(db, {
			sliceId: sliceId2,
			phase: "plan",
			status: "completed",
			startedAt: new Date().toISOString(),
		});

		const report = handleDoctor(db, { root });
		expect(report.message).toMatch(/Log\/projection drift/);
		expect(report.message).toMatch(/manual investigation required/);
	});

	it("ok is false when --repair runs but invariant violations remain", () => {
		appendCommand(root, "write-plan", { sliceId: "ghost-slice" });
		const report = handleDoctor(db, { root, repair: true });
		expect(report.ok).toBe(false);
		expect(report.invariantViolations.length).toBeGreaterThan(0);
	});
});
