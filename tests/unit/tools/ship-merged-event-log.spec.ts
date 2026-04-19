import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	getSlice,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	updateSlicePrUrl,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleShipMerged } from "../../../src/tools/ship-merged.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as Parameters<typeof handleShipMerged>[0];
}

describe("handleShipMerged — event log", () => {
	test("appends one ship-merged event, advances cursor, closes slice, and completes ship phase_run", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-ship-merged-el-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		const prUrl = "https://github.com/org/repo/pull/42";
		db.prepare("UPDATE slice SET status = 'shipping', tier = 'S' WHERE id = ?").run(sId);
		updateSlicePrUrl(db, sId, prUrl);
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const pi = makePi();
		const result = handleShipMerged(pi, db, root, sId, prUrl);
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("ship-merged");
		expect(events[0]?.params).toMatchObject({ sliceId: sId, prUrl });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		expect(getSlice(db, sId)?.status).toBe("closed");
		const run = getLatestPhaseRun(db, sId, "ship");
		expect(run?.status).toBe("completed");
	});
});
