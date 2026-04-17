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

// ---------------------------------------------------------------------------
// Helper: create a DB and run migrations only up to version 3 (just before
// the v4 reconcile migration). This lets us test v4 behavior in isolation
// without the idempotency issue from v5's ALTER TABLE ADD COLUMN.
// ---------------------------------------------------------------------------

function applyMigrationsUpToV3(db: Database.Database): void {
	// v1 baseline schema
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS project (
			id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
			name TEXT NOT NULL,
			vision TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS milestone (
			id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
			project_id TEXT NOT NULL REFERENCES project(id),
			number INTEGER NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'created',
			branch TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS slice (
			id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
			milestone_id TEXT NOT NULL REFERENCES milestone(id),
			number INTEGER NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'created',
			tier TEXT,
			pr_url TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS task (
			id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
			slice_id TEXT NOT NULL REFERENCES slice(id),
			number INTEGER NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			wave INTEGER,
			claimed_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS task_dependency (
			from_task_id TEXT NOT NULL REFERENCES task(id),
			to_task_id TEXT NOT NULL REFERENCES task(id),
			PRIMARY KEY (from_task_id, to_task_id)
		);
		INSERT INTO schema_version (version) VALUES (1);
	`);

	// v2: add phase_run + event_log
	db.exec(`
		CREATE TABLE IF NOT EXISTS phase_run (
			id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
			slice_id TEXT NOT NULL REFERENCES slice(id),
			phase TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'started',
			started_at TEXT NOT NULL,
			finished_at TEXT,
			duration_ms INTEGER,
			error TEXT,
			feedback TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_phase_run_slice ON phase_run(slice_id);
		CREATE INDEX IF NOT EXISTS idx_phase_run_phase ON phase_run(phase);
		CREATE TABLE IF NOT EXISTS event_log (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			channel    TEXT NOT NULL,
			type       TEXT NOT NULL,
			slice_id   TEXT NOT NULL,
			payload    TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_event_log_slice ON event_log(slice_id);
		CREATE INDEX IF NOT EXISTS idx_event_log_channel ON event_log(channel);
		INSERT INTO schema_version (version) VALUES (2);
	`);

	// v3: no-op
	db.prepare("INSERT INTO schema_version (version) VALUES (3)").run();
}

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
		// Set up DB at v3 state with stale data
		applyMigrationsUpToV3(db);
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

		// Run full migrations from v3 → v4 → v5
		applyMigrations(db, { root });

		expect(getSlice(db, sliceId)?.status).toBe("executing");
	});

	it("leaves closed slices untouched", () => {
		applyMigrationsUpToV3(db);
		const projectId = insertProject(db, { name: "p", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "m",
			branch: "m01",
		});
		const sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(sliceId);

		applyMigrations(db, { root });

		expect(getSlice(db, sliceId)?.status).toBe("closed");
	});

	it("bumps version to current max (5) after full migration", () => {
		applyMigrationsUpToV3(db);
		applyMigrations(db);
		const v = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
		// Schema v5 is the current maximum.
		expect(v.v).toBe(5);
	});

	it("migration is atomic — v4 reconcile runs and v4 version row is recorded", () => {
		applyMigrationsUpToV3(db);
		const projectId = insertProject(db, { name: "p", vision: "v" });
		const milestoneId = insertMilestone(db, { projectId, number: 1, name: "m", branch: "m01" });
		const sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		applyMigrations(db, { root });

		// Slice reconciled by v4 migration
		expect(getSlice(db, sliceId)?.status).toBe("executing");
		// v4 row was inserted
		const count4 = db
			.prepare("SELECT COUNT(*) as c FROM schema_version WHERE version = 4")
			.get() as { c: number };
		expect(count4.c).toBe(1);
	});

	it("survives per-slice reconcile failures and still bumps version", () => {
		applyMigrationsUpToV3(db);
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

		// Silence the expected console.error during this test
		const origError = console.error;
		console.error = () => {};
		try {
			applyMigrations(db, { root });
		} finally {
			console.error = origError;
		}

		expect(getSlice(db, goodSliceId)?.status).toBe("executing");
		// All migrations ran up to v5
		const v = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
		expect(v.v).toBe(5);
	});
});
