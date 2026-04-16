import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { STALLED_THRESHOLD_MS, handleDoctor } from "../../../src/commands/doctor.js";
import {
	applyMigrations,
	getMilestones,
	getPhaseRuns,
	getProject,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

describe("handleDoctor closed-slice orphan cleanup", () => {
	let db: Database.Database;
	let openSliceId: string;
	let closedSliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;

		insertSlice(db, { milestoneId, number: 1, title: "Open" });
		insertSlice(db, { milestoneId, number: 2, title: "Closed" });
		const slices = getSlices(db, milestoneId);
		openSliceId = must(slices[0]).id;
		closedSliceId = must(slices[1]).id;
		// Mark the second slice closed. `insertSlice` may not take a status
		// argument, so use a direct UPDATE.
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(closedSliceId);
	});

	it("does not report phase_runs on closed slices as stalled", () => {
		const now = Date.now();
		const stallAge = STALLED_THRESHOLD_MS * 3;
		insertPhaseRun(db, {
			sliceId: closedSliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - stallAge).toISOString(),
		});

		const report = handleDoctor(db, { now });
		expect(report.stalledPhases).toHaveLength(0);
	});

	it("still reports phase_runs on open slices as stalled", () => {
		const now = Date.now();
		const stallAge = STALLED_THRESHOLD_MS * 3;
		insertPhaseRun(db, {
			sliceId: openSliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - stallAge).toISOString(),
		});

		const report = handleDoctor(db, { now });
		expect(report.stalledPhases).toHaveLength(1);
		expect(must(report.stalledPhases[0]).sliceId).toBe(openSliceId);
	});

	it("marks orphan 'started' phase_runs on closed slices as abandoned", () => {
		const now = Date.now();
		insertPhaseRun(db, {
			sliceId: closedSliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - STALLED_THRESHOLD_MS * 3).toISOString(),
		});

		handleDoctor(db, { now });

		const runs = getPhaseRuns(db, closedSliceId);
		expect(runs).toHaveLength(1);
		expect(must(runs[0]).status).toBe("abandoned");
		expect(must(runs[0]).finishedAt).toBeTruthy();
	});

	it("is idempotent — a second run is a no-op and still reports 0 stalls", () => {
		const now = Date.now();
		insertPhaseRun(db, {
			sliceId: closedSliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date(now - STALLED_THRESHOLD_MS * 3).toISOString(),
		});

		handleDoctor(db, { now });
		const second = handleDoctor(db, { now });
		expect(second.stalledPhases).toHaveLength(0);

		const runs = getPhaseRuns(db, closedSliceId);
		expect(runs).toHaveLength(1);
		expect(must(runs[0]).status).toBe("abandoned");
	});

	it("leaves completed phase_runs on closed slices alone", () => {
		const now = Date.now();
		const id = insertPhaseRun(db, {
			sliceId: closedSliceId,
			phase: "plan",
			status: "completed",
			startedAt: new Date(now - STALLED_THRESHOLD_MS * 3).toISOString(),
		});

		handleDoctor(db, { now });

		const runs = getPhaseRuns(db, closedSliceId);
		const row = must(runs.find((r) => r.id === id));
		expect(row.status).toBe("completed");
	});
});
