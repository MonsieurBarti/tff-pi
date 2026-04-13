import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	readArtifact,
} from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	getTasks,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { handleWriteReview } from "../../../src/tools/write-review.js";
import { must } from "../../helpers.js";

describe("handleWriteReview", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-write-review-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		initSliceDir(root, 1, 1);
		updateSliceStatus(db, sliceId, "reviewing");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes REVIEW.md on approved verdict and leaves slice reviewing", () => {
		const result = handleWriteReview(db, root, sliceId, "# Review\napproved", "approved");
		expect(result.isError).toBeUndefined();
		expect(readArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md")).toContain("approved");
		expect(must(getSlice(db, sliceId)).status).toBe("reviewing");
	});

	it("routes slice back to executing on denied verdict and resets tasks", () => {
		insertTask(db, { sliceId, number: 1, title: "T1", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "T2", wave: 1 });
		// Mark tasks complete to verify they get reset
		db.prepare("UPDATE task SET status = 'complete' WHERE slice_id = ?").run(sliceId);

		const result = handleWriteReview(db, root, sliceId, "# Review\ndenied", "denied");
		expect(result.isError).toBeUndefined();
		expect(result.details.routedTo).toBe("executing");
		expect(must(getSlice(db, sliceId)).status).toBe("executing");

		const tasks = getTasks(db, sliceId);
		for (const t of tasks) {
			expect(t.status).toBe("open");
		}
	});

	it("errors on unknown slice", () => {
		const result = handleWriteReview(db, root, "nope", "x", "approved");
		expect(result.isError).toBe(true);
	});
});
