import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
	} as unknown as ExtensionAPI;
}

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
		const pi = makePi();
		const result = handleWriteReview(pi, db, root, sliceId, "# Review\napproved", "approved");
		expect(result.isError).toBeUndefined();
		expect(readArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md")).toContain("approved");
		expect(must(getSlice(db, sliceId)).status).toBe("reviewing");
		// approved verdict does NOT emit phase_failed
		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("routes slice back to executing on denied verdict: emits phase_failed for review and resets tasks", () => {
		const pi = makePi();
		insertTask(db, { sliceId, number: 1, title: "T1", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "T2", wave: 1 });
		// Mark tasks complete to verify they get reset
		db.prepare("UPDATE task SET status = 'complete' WHERE slice_id = ?").run(sliceId);

		const result = handleWriteReview(pi, db, root, sliceId, "# Review\ndenied", "denied");
		expect(result.isError).toBeUndefined();
		expect(result.details.routedTo).toBe("executing");

		// Reconciler (rule 3: review/failed → executing) handles status transition;
		// we verify the event was emitted instead of a direct DB write.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_failed", phase: "review" }),
		);

		const tasks = getTasks(db, sliceId);
		for (const t of tasks) {
			expect(t.status).toBe("open");
		}
	});

	it("errors on unknown slice", () => {
		const pi = makePi();
		const result = handleWriteReview(pi, db, root, "nope", "x", "approved");
		expect(result.isError).toBe(true);
	});
});
