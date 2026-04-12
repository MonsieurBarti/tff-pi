import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleShipChanges } from "../../../src/commands/ship-changes.js";
import {
	applyMigrations,
	getSlice,
	getTasksByWave,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceStatus,
	updateTaskStatus,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function fakePi() {
	return {
		events: { emit: vi.fn() },
	} as unknown as Parameters<typeof handleShipChanges>[0];
}

describe("handleShipChanges", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		const projectId = insertProject(db, { name: "test", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});
		sliceId = insertSlice(db, { milestoneId, number: 1, title: "slice" });
		updateSliceStatus(db, sliceId, "shipping");
	});

	afterEach(() => {
		db.close();
	});

	it("flips slice back to executing and resets tasks to open", () => {
		const taskId = insertTask(db, {
			sliceId,
			number: 1,
			title: "t",
			wave: 1,
		});
		updateTaskStatus(db, taskId, "closed");

		const result = handleShipChanges(fakePi(), db, sliceId, "fix the thing");
		if (!result.success) throw new Error("expected success");
		expect(result.feedback).toBe("fix the thing");

		const slice = must(getSlice(db, sliceId));
		expect(slice.status).toBe("executing");

		const tasks = [...getTasksByWave(db, sliceId).values()].flat();
		expect(must(tasks[0]).status).toBe("open");
	});

	it("rejects empty feedback", () => {
		const result = handleShipChanges(fakePi(), db, sliceId, "   ");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/feedback/i);
	});

	it("refuses to reopen a closed slice", () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = handleShipChanges(fakePi(), db, sliceId, "feedback");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/closed/i);
	});
});
