import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";

let db: Database.Database;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mig-v4-"));
	db = openDatabase(":memory:");
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

describe("schema v4 migration — reconcile all non-closed slices", () => {
	it("reconciles a stale slice.status from phase_run evidence", () => {
		applyMigrations(db);
		const projectId = insertProject(db, { name: "p", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "m",
			branch: "m01",
		});
		const sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
		// Seed: slice.status = 'planning' (stale) but latest phase_run is execute/started
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		// Simulate downgrade by deleting v4 row
		db.prepare("DELETE FROM schema_version WHERE version = 4").run();

		applyMigrations(db, { root });

		expect(getSlice(db, sliceId)?.status).toBe("executing");
	});

	it("leaves closed slices untouched", () => {
		applyMigrations(db);
		const projectId = insertProject(db, { name: "p", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "m",
			branch: "m01",
		});
		const sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(sliceId);
		db.prepare("DELETE FROM schema_version WHERE version = 4").run();

		applyMigrations(db, { root });

		expect(getSlice(db, sliceId)?.status).toBe("closed");
	});

	it("bumps version to 4 even without root", () => {
		applyMigrations(db);
		const v = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
		expect(v.v).toBe(4);
	});

	it("survives per-slice reconcile failures and still bumps version", () => {
		applyMigrations(db);
		const projectId = insertProject(db, { name: "p", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "m",
			branch: "m01",
		});
		const goodSliceId = insertSlice(db, { milestoneId, number: 1, title: "ok" });
		const badSliceId = insertSlice(db, { milestoneId, number: 2, title: "bad" });

		// Seed good slice with stale status (will reconcile to "executing")
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(goodSliceId);
		insertPhaseRun(db, {
			sliceId: goodSliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		// Corrupt bad slice so reconcile throws (invalid tier)
		db.prepare("UPDATE slice SET tier = 'INVALID' WHERE id = ?").run(badSliceId);

		// Downgrade to trigger re-migration
		db.prepare("DELETE FROM schema_version WHERE version = 4").run();

		// Silence the expected console.error during this test
		const origError = console.error;
		console.error = () => {};
		try {
			applyMigrations(db, { root });
		} finally {
			console.error = origError;
		}

		expect(getSlice(db, goodSliceId)?.status).toBe("executing");
		// Bad slice row is still present (migration didn't rollback); its tier is invalid
		// so getSlice would throw — just assert schema_version = 4
		const v = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
		expect(v.v).toBe(4);
	});
});
