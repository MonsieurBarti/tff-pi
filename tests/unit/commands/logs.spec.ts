import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { handleLogs } from "../../../src/commands/logs.js";
import {
	applyMigrations,
	insertEventLog,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
function createTestDb(): Database.Database {
	const db = new Database(":memory:");
	applyMigrations(db);
	return db;
}

function seedSlice(db: Database.Database): string {
	insertProject(db, { name: "TFF", vision: "Vision" });
	const row = db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
	const projectId = row.id;
	insertMilestone(db, { projectId, number: 1, name: "M01", branch: "milestone/M01" });
	const m = db.prepare("SELECT id FROM milestone LIMIT 1").get() as { id: string };
	insertSlice(db, { milestoneId: m.id, number: 1, title: "S01" });
	const s = db.prepare("SELECT id FROM slice LIMIT 1").get() as { id: string };
	return s.id;
}

describe("handleLogs", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("returns no-events message when empty", () => {
		const sliceId = seedSlice(db);
		const result = handleLogs(db, sliceId);
		expect(result).toContain("No events");
	});

	it("returns timeline for a slice", () => {
		const sliceId = seedSlice(db);
		insertEventLog(db, {
			channel: "phase",
			type: "phase_started",
			sliceId,
			payload: JSON.stringify({ timestamp: "2026-04-11T10:30:00.000Z", phase: "research" }),
		});
		insertEventLog(db, {
			channel: "phase",
			type: "phase_completed",
			sliceId,
			payload: JSON.stringify({
				timestamp: "2026-04-11T10:31:30.000Z",
				phase: "research",
				durationMs: 90000,
			}),
		});

		const result = handleLogs(db, sliceId);
		expect(result).toContain("10:30:00");
		expect(result).toContain("phase_started");
		expect(result).toContain("research");
		expect(result).toContain("10:31:30");
		expect(result).toContain("phase_completed");
		expect(result).toContain("1m30s");
	});

	it("formats wave and task count fields", () => {
		const sliceId = seedSlice(db);
		insertEventLog(db, {
			channel: "execute",
			type: "wave_started",
			sliceId,
			payload: JSON.stringify({
				timestamp: "2026-04-11T11:00:00.000Z",
				wave: 2,
				totalWaves: 4,
				taskCount: 3,
			}),
		});

		const result = handleLogs(db, sliceId);
		expect(result).toContain("wave=2/4");
		expect(result).toContain("tasks=3");
	});

	it("formats verdict and tier fields", () => {
		const sliceId = seedSlice(db);
		insertEventLog(db, {
			channel: "review",
			type: "review_verdict",
			sliceId,
			payload: JSON.stringify({
				timestamp: "2026-04-11T12:00:00.000Z",
				tier: "SSS",
				verdict: "approved",
			}),
		});

		const result = handleLogs(db, sliceId);
		expect(result).toContain("tier=SSS");
		expect(result).toContain("approved");
	});

	it("truncates error to 60 chars", () => {
		const sliceId = seedSlice(db);
		const longError = "a".repeat(80);
		insertEventLog(db, {
			channel: "phase",
			type: "phase_failed",
			sliceId,
			payload: JSON.stringify({ timestamp: "2026-04-11T13:00:00.000Z", error: longError }),
		});

		const result = handleLogs(db, sliceId);
		expect(result).toContain("a".repeat(60));
		expect(result).not.toContain("a".repeat(61));
	});

	it("returns json when format is json", () => {
		const sliceId = seedSlice(db);
		const payload1 = JSON.stringify({ timestamp: "2026-04-11T10:00:00.000Z", phase: "plan" });
		const payload2 = JSON.stringify({ timestamp: "2026-04-11T10:05:00.000Z", phase: "execute" });
		insertEventLog(db, { channel: "phase", type: "phase_started", sliceId, payload: payload1 });
		insertEventLog(db, { channel: "phase", type: "phase_started", sliceId, payload: payload2 });

		const result = handleLogs(db, sliceId, { json: true });
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("uses fallback time when timestamp missing", () => {
		const sliceId = seedSlice(db);
		insertEventLog(db, {
			channel: "phase",
			type: "phase_started",
			sliceId,
			payload: JSON.stringify({ phase: "discuss" }),
		});

		const result = handleLogs(db, sliceId);
		expect(result).toContain("??:??:??");
	});
});
