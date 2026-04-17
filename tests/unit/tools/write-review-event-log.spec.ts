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
import { handleWriteReview } from "../../../src/tools/write-review.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
	} as unknown as Parameters<typeof handleWriteReview>[0];
}

describe("handleWriteReview — event log", () => {
	test("approved: appends one write-review event, advances cursor, and completes phase_run", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-review-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "review",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const pi = makePi();
		const result = handleWriteReview(pi, db, root, sId, "# Review\napproved", "approved");
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-review");
		expect(events[0]?.params).toEqual({ sliceId: sId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		const run = getLatestPhaseRun(db, sId, "review");
		expect(run?.status).toBe("completed");
	});
});
