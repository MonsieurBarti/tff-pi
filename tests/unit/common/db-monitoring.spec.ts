import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getEventLog,
	getLatestPhaseRun,
	getMilestones,
	getPhaseRuns,
	getProject,
	getSlices,
	insertEventLog,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
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
	it("creates phase_run and event_log tables", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toContain("phase_run");
		expect(names).toContain("event_log");
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

describe("event_log", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		sliceId = seedSlice(db);
	});

	it("inserts and retrieves an event_log entry", () => {
		insertEventLog(db, {
			channel: "phase",
			type: "phase.started",
			sliceId,
			payload: JSON.stringify({ phase: "research" }),
		});

		const entries = getEventLog(db, sliceId);
		expect(entries).toHaveLength(1);
		const entry = must(entries[0]);
		expect(entry.id).toBeTypeOf("number");
		expect(entry.channel).toBe("phase");
		expect(entry.type).toBe("phase.started");
		expect(entry.sliceId).toBe(sliceId);
		expect(entry.payload).toBe(JSON.stringify({ phase: "research" }));
		expect(entry.createdAt).toBeDefined();
	});

	it("inserts multiple entries and retrieves all", () => {
		insertEventLog(db, {
			channel: "phase",
			type: "phase.started",
			sliceId,
			payload: "{}",
		});
		insertEventLog(db, {
			channel: "agent",
			type: "agent.claimed",
			sliceId,
			payload: "{}",
		});
		insertEventLog(db, {
			channel: "phase",
			type: "phase.finished",
			sliceId,
			payload: "{}",
		});

		const entries = getEventLog(db, sliceId);
		expect(entries).toHaveLength(3);
	});

	it("filters event_log by channel", () => {
		insertEventLog(db, { channel: "phase", type: "phase.started", sliceId, payload: "{}" });
		insertEventLog(db, { channel: "agent", type: "agent.claimed", sliceId, payload: "{}" });
		insertEventLog(db, { channel: "phase", type: "phase.finished", sliceId, payload: "{}" });

		const phaseEntries = getEventLog(db, sliceId, "phase");
		expect(phaseEntries).toHaveLength(2);
		expect(phaseEntries.every((e) => e.channel === "phase")).toBe(true);

		const agentEntries = getEventLog(db, sliceId, "agent");
		expect(agentEntries).toHaveLength(1);
		expect(must(agentEntries[0]).type).toBe("agent.claimed");
	});

	it("returns empty array when no entries exist", () => {
		expect(getEventLog(db, sliceId)).toHaveLength(0);
	});

	it("returns entries ordered by id (insertion order)", () => {
		insertEventLog(db, { channel: "phase", type: "phase.started", sliceId, payload: "{}" });
		insertEventLog(db, { channel: "phase", type: "phase.finished", sliceId, payload: "{}" });

		const entries = getEventLog(db, sliceId);
		expect(entries[0]?.id).toBeLessThan(must(entries[1]).id);
	});
});
