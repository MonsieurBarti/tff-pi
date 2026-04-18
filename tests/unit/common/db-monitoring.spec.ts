import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	getMilestones,
	getPhaseRuns,
	getProject,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	recoverOrphanedPhaseRuns,
	updatePhaseRun,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function seedSlice(db: Database.Database): string {
	insertProject(db, { name: "TFF", vision: "Vision" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	return must(getSlices(db, milestoneId)[0]).id;
}

describe("applyMigrations — monitoring tables", () => {
	it("creates phase_run table (event_log dropped by v5)", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toContain("phase_run");
		// event_log was dropped in schema v5 — verify it is gone
		expect(names).not.toContain("event_log");
	});

	it("creates schema_version table and records versions", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		const rows = db.prepare("SELECT version FROM schema_version ORDER BY version").all() as {
			version: number;
		}[];
		const versions = rows.map((r) => r.version);
		expect(versions).toContain(1);
		expect(versions).toContain(2);
	});

	it("is idempotent — running twice does not duplicate schema_version rows", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		applyMigrations(db);
		const rows = db.prepare("SELECT version FROM schema_version ORDER BY version").all() as {
			version: number;
		}[];
		expect(rows.filter((r) => r.version === 1)).toHaveLength(1);
		expect(rows.filter((r) => r.version === 2)).toHaveLength(1);
	});
});

describe("phase_run", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		sliceId = seedSlice(db);
	});

	it("inserts and retrieves a phase_run", () => {
		const id = insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "running",
			startedAt: "2024-01-01T00:00:00Z",
		});
		expect(id).toBeDefined();

		const runs = getPhaseRuns(db, sliceId);
		expect(runs).toHaveLength(1);
		const run = must(runs[0]);
		expect(run.id).toBe(id);
		expect(run.sliceId).toBe(sliceId);
		expect(run.phase).toBe("research");
		expect(run.status).toBe("running");
		expect(run.startedAt).toBe("2024-01-01T00:00:00Z");
		expect(run.finishedAt).toBeNull();
		expect(run.durationMs).toBeNull();
		expect(run.error).toBeNull();
		expect(run.feedback).toBeNull();
		expect(run.metadata).toBeNull();
		expect(run.createdAt).toBeDefined();
	});

	it("updates phase_run with completion data", () => {
		const id = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "running",
			startedAt: "2024-01-01T00:00:00Z",
		});

		updatePhaseRun(db, id, {
			status: "done",
			finishedAt: "2024-01-01T00:01:00Z",
			durationMs: 60000,
			feedback: "Looks good",
			metadata: JSON.stringify({ tokensUsed: 1500 }),
		});

		const runs = getPhaseRuns(db, sliceId);
		const run = must(runs[0]);
		expect(run.status).toBe("done");
		expect(run.finishedAt).toBe("2024-01-01T00:01:00Z");
		expect(run.durationMs).toBe(60000);
		expect(run.feedback).toBe("Looks good");
		expect(run.metadata).toBe(JSON.stringify({ tokensUsed: 1500 }));
		expect(run.error).toBeNull();
	});

	it("updates phase_run with error data", () => {
		const id = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "running",
			startedAt: "2024-01-01T00:00:00Z",
		});

		updatePhaseRun(db, id, {
			status: "failed",
			finishedAt: "2024-01-01T00:00:30Z",
			durationMs: 30000,
			error: "Timeout exceeded",
		});

		const run = must(getLatestPhaseRun(db, sliceId));
		expect(run.status).toBe("failed");
		expect(run.error).toBe("Timeout exceeded");
	});

	it("returns empty array when no phase_runs exist", () => {
		expect(getPhaseRuns(db, sliceId)).toHaveLength(0);
	});

	it("getLatestPhaseRun returns null when no runs", () => {
		expect(getLatestPhaseRun(db, sliceId)).toBeNull();
	});

	it("getLatestPhaseRun returns most recent run without phase filter", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "done",
			startedAt: "2024-01-01T00:00:00Z",
		});
		const id2 = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "running",
			startedAt: "2024-01-01T00:01:00Z",
		});

		const latest = must(getLatestPhaseRun(db, sliceId));
		expect(latest.id).toBe(id2);
	});

	it("getLatestPhaseRun filters by phase", () => {
		const id1 = insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "done",
			startedAt: "2024-01-01T00:00:00Z",
		});
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "running",
			startedAt: "2024-01-01T00:01:00Z",
		});

		const latest = must(getLatestPhaseRun(db, sliceId, "research"));
		expect(latest.id).toBe(id1);
		expect(latest.phase).toBe("research");
	});

	it("partial updatePhaseRun preserves existing fields", () => {
		const id = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: "2024-01-01T00:00:00Z",
		});

		// First update: set feedback and metadata
		updatePhaseRun(db, id, {
			status: "running",
			feedback: "initial feedback",
			metadata: JSON.stringify({ step: 1 }),
		});

		// Second update: change status only — feedback and metadata must survive
		updatePhaseRun(db, id, { status: "done" });

		const run = must(getLatestPhaseRun(db, sliceId));
		expect(run.status).toBe("done");
		expect(run.feedback).toBe("initial feedback");
		expect(run.metadata).toBe(JSON.stringify({ step: 1 }));
	});

	it("recoverOrphanedPhaseRuns marks started runs as abandoned", () => {
		const id1 = insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "started",
			startedAt: "2024-01-01T00:00:00Z",
		});
		const id2 = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: "2024-01-01T00:01:00Z",
		});
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "done",
			startedAt: "2024-01-01T00:02:00Z",
		});

		const recovered = recoverOrphanedPhaseRuns(db);
		expect(recovered).toBe(2);

		const runs = getPhaseRuns(db, sliceId);
		const run1 = must(runs.find((r) => r.id === id1));
		const run2 = must(runs.find((r) => r.id === id2));
		expect(run1.status).toBe("abandoned");
		expect(run1.finishedAt).not.toBeNull();
		expect(run2.status).toBe("abandoned");
	});

	it("recoverOrphanedPhaseRuns returns 0 when no orphans", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "done",
			startedAt: "2024-01-01T00:00:00Z",
		});
		expect(recoverOrphanedPhaseRuns(db)).toBe(0);
	});

	it("getPhaseRuns returns runs ordered by created_at", () => {
		const id1 = insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "done",
			startedAt: "2024-01-01T00:00:00Z",
		});
		const id2 = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "running",
			startedAt: "2024-01-01T00:01:00Z",
		});

		const runs = getPhaseRuns(db, sliceId);
		expect(runs).toHaveLength(2);
		expect(runs[0]?.id).toBe(id1);
		expect(runs[1]?.id).toBe(id2);
	});
});
