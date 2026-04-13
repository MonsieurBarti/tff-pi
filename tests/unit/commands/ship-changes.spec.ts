import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleShipChanges } from "../../../src/commands/ship-changes.js";
import { initTffDirectory } from "../../../src/common/artifacts.js";
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
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-ship-changes-"));
		initTffDirectory(root);
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
		rmSync(root, { recursive: true, force: true });
	});

	it("stashes review feedback as an artifact and leaves slice in shipping", () => {
		const taskId = insertTask(db, {
			sliceId,
			number: 1,
			title: "t",
			wave: 1,
		});
		updateTaskStatus(db, taskId, "closed");

		const result = handleShipChanges(fakePi(), db, root, sliceId, "fix the thing");
		if (!result.success) throw new Error("expected success");
		expect(result.feedback).toBe("fix the thing");

		// Slice stays in shipping — user decides whether to edit worktree or re-run execute.
		const slice = must(getSlice(db, sliceId));
		expect(slice.status).toBe("shipping");

		// Tasks are NOT reset — small fixes don't need a full TDD loop.
		const tasks = [...getTasksByWave(db, sliceId).values()].flat();
		expect(must(tasks[0]).status).toBe("closed");

		// Feedback is stashed under the slice artifact dir.
		const feedbackPath = join(
			root,
			".tff",
			"milestones",
			"M01",
			"slices",
			"M01-S01",
			"REVIEW_FEEDBACK.md",
		);
		const body = readFileSync(feedbackPath, "utf-8");
		expect(body).toContain("fix the thing");
	});

	it("rejects empty feedback", () => {
		const result = handleShipChanges(fakePi(), db, root, sliceId, "   ");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/feedback/i);
	});

	it("refuses to reopen a closed slice", () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = handleShipChanges(fakePi(), db, root, sliceId, "feedback");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/closed/i);
	});
});
