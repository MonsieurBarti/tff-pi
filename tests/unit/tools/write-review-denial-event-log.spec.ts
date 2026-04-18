import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	getTasks,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleWriteReview } from "../../../src/tools/write-review.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
	} as unknown as Parameters<typeof handleWriteReview>[0];
}

describe("handleWriteReview denial — event log", () => {
	test("appends one review-rejected event, marks phase_run failed, resets tasks to open", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-review-denial-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'reviewing' WHERE id = ?").run(sId);

		// Seed a started phase_run for review
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "review",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		// Seed tasks in complete state to verify they get reset
		insertTask(db, { sliceId: sId, number: 1, title: "Task A", wave: 1 });
		insertTask(db, { sliceId: sId, number: 2, title: "Task B", wave: 1 });
		db.prepare("UPDATE task SET status = 'complete' WHERE slice_id = ?").run(sId);

		const pi = makePi();
		const result = handleWriteReview(pi, db, root, sId, "# Review\ndenied", "denied");
		expect(result.isError).toBeFalsy();

		// One review-rejected event logged
		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("review-rejected");
		expect((events[0]?.params as Record<string, unknown>).sliceId).toBe(sId);

		// Cursor advanced
		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		// phase_run.review marked failed
		const run = getLatestPhaseRun(db, sId, "review");
		expect(run?.status).toBe("failed");
		expect(run?.finishedAt).toBeDefined();

		// Tasks reset to open
		const tasks = getTasks(db, sId);
		for (const t of tasks) {
			expect(t.status).toBe("open");
		}

		// Bus event emitted
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_failed", phase: "review" }),
		);
	});
});
