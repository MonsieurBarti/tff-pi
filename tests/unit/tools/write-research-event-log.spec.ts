import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleWriteResearch } from "../../../src/tools/write-research.js";

describe("handleWriteResearch — event log", () => {
	test("appends one write-research event, advances cursor, and completes phase_run", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-research-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "research",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const result = handleWriteResearch(db, root, sId, "# Research\n");
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-research");
		expect(events[0]?.params).toEqual({ sliceId: sId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		const run = getLatestPhaseRun(db, sId, "research");
		expect(run?.status).toBe("completed");
	});
});
