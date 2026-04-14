import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	insertDependency,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
} from "../../../src/common/db.js";
import {
	SNAPSHOT_FILENAME,
	SNAPSHOT_SCHEMA_VERSION,
	exportSnapshot,
} from "../../../src/common/state-exporter.js";

describe("exportSnapshot", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
	});
	afterEach(() => db.close());

	it("emits empty arrays and the current schemaVersion on an empty DB", () => {
		const snap = exportSnapshot(db, { now: () => new Date("2026-04-14T00:00:00Z") });
		expect(snap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
		expect(snap.exportedAt).toBe("2026-04-14T00:00:00.000Z");
		expect(snap.project).toEqual([]);
		expect(snap.milestone).toEqual([]);
		expect(snap.slice).toEqual([]);
		expect(snap.task).toEqual([]);
		expect(snap.dependency).toEqual([]);
		expect(snap.phase_run).toEqual([]);
	});

	it("exposes SNAPSHOT_FILENAME as 'state-snapshot.json'", () => {
		expect(SNAPSHOT_FILENAME).toBe("state-snapshot.json");
	});
});

describe("exportSnapshot with data", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
	});
	afterEach(() => db.close());

	it("includes project, milestone, slice, task, dependency, phase_run rows", () => {
		const pid = insertProject(db, { name: "P", vision: "V" });
		const mid = insertMilestone(db, {
			projectId: pid,
			number: 1,
			name: "M01",
			branch: "feature/m01",
		});
		const sid = insertSlice(db, { milestoneId: mid, number: 1, title: "S1" });
		const t1 = insertTask(db, { sliceId: sid, number: 1, title: "T1", wave: 1 });
		const t2 = insertTask(db, { sliceId: sid, number: 2, title: "T2", wave: 1 });
		insertDependency(db, { fromTaskId: t1, toTaskId: t2 });
		insertPhaseRun(db, {
			sliceId: sid,
			phase: "plan",
			status: "started",
			startedAt: "2026-04-14T00:00:00Z",
		});

		const snap = exportSnapshot(db);
		expect(snap.project).toHaveLength(1);
		expect(snap.project[0]?.id).toBe(pid);
		expect(snap.milestone).toHaveLength(1);
		expect(snap.slice).toHaveLength(1);
		expect(snap.task).toHaveLength(2);
		expect(snap.dependency).toHaveLength(1);
		expect(snap.dependency[0]?.id).toBe(`${t1}:${t2}`);
		expect(snap.dependency[0]?.fromTaskId).toBe(t1);
		expect(snap.dependency[0]?.toTaskId).toBe(t2);
		expect(snap.phase_run).toHaveLength(1);
	});

	it("sorts each table array by id ascending", () => {
		const pid = insertProject(db, { name: "P", vision: "V" });
		const mid = insertMilestone(db, { projectId: pid, number: 1, name: "M01", branch: "b" });
		const sid1 = insertSlice(db, { milestoneId: mid, number: 1, title: "A" });
		const sid2 = insertSlice(db, { milestoneId: mid, number: 2, title: "B" });
		const sid3 = insertSlice(db, { milestoneId: mid, number: 3, title: "C" });

		const snap = exportSnapshot(db);
		const ids = snap.slice.map((s) => s.id);
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
		expect(new Set(ids)).toEqual(new Set([sid1, sid2, sid3]));
	});

	it("excludes event_log rows from the snapshot", () => {
		const pid = insertProject(db, { name: "P", vision: "V" });
		const mid = insertMilestone(db, { projectId: pid, number: 1, name: "M", branch: "b" });
		const sid = insertSlice(db, { milestoneId: mid, number: 1, title: "S" });
		db.prepare(
			"INSERT INTO event_log (channel, type, slice_id, payload) VALUES ('x','y',?,'{}')",
		).run(sid);
		const snap = exportSnapshot(db);
		expect((snap as unknown as Record<string, unknown>).event_log).toBeUndefined();
	});
});
