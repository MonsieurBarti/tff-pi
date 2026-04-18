import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleShipFix } from "../../../src/tools/ship-fix.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as Parameters<typeof handleShipFix>[0];
}

describe("handleShipFix — event log", () => {
	test("appends one ship-fix event, advances cursor, and marks ship phase_run failed", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-ship-fix-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'shipping', tier = 'S' WHERE id = ?").run(sId);
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const pi = makePi();
		const result = handleShipFix(pi, db, root, sId);
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("ship-fix");
		expect(events[0]?.params).toMatchObject({ sliceId: sId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		const run = getLatestPhaseRun(db, sId, "ship");
		expect(run?.status).toBe("failed");
	});
});
