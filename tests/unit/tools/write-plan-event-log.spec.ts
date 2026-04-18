import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	getTasks,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleWritePlan } from "../../../src/tools/write-plan.js";

describe("handleWritePlan — event log", () => {
	test("appends one write-plan event, advances cursor, completes phase_run, and persists tasks", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-plan-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const tasks = [
			{ title: "Task A", description: "First task" },
			{ title: "Task B", description: "Second task", dependsOn: [1] },
		];

		const result = handleWritePlan(db, root, sId, "# Plan\n", tasks);
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-plan");
		const params = events[0]?.params as Record<string, unknown>;
		expect(params.sliceId).toBe(sId);
		expect(Array.isArray(params.tasks)).toBe(true);
		expect((params.tasks as unknown[]).length).toBe(2);
		expect(Array.isArray(params.dependencies)).toBe(true);

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		const run = getLatestPhaseRun(db, sId, "plan");
		expect(run?.status).toBe("completed");

		const dbTasks = getTasks(db, sId);
		expect(dbTasks).toHaveLength(2);
		expect(dbTasks[0]?.title).toBe("Task A");
		expect(dbTasks[1]?.title).toBe("Task B");
	});
});
