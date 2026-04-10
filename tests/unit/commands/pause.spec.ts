import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePause } from "../../../src/commands/pause.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("handlePause", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("pauses an active slice in discussing status", () => {
		updateSliceStatus(db, sliceId, "discussing");
		const result = handlePause(db, sliceId);
		expect(result.success).toBe(true);
		expect(must(getSlice(db, sliceId)).status).toBe("paused");
	});

	it("pauses an active slice in executing status", () => {
		updateSliceStatus(db, sliceId, "executing");
		const result = handlePause(db, sliceId);
		expect(result.success).toBe(true);
		expect(must(getSlice(db, sliceId)).status).toBe("paused");
	});

	it("fails for closed slice", () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = handlePause(db, sliceId);
		expect(result.success).toBe(false);
		expect(result.error).toContain("closed");
	});

	it("fails for already paused slice", () => {
		updateSliceStatus(db, sliceId, "paused");
		const result = handlePause(db, sliceId);
		expect(result.success).toBe(false);
		expect(result.error).toContain("paused");
	});

	it("fails for unknown slice id", () => {
		const result = handlePause(db, "nonexistent");
		expect(result.success).toBe(false);
		expect(result.error).toContain("Slice not found");
	});

	it("fails for created status (not yet started)", () => {
		// created -> paused is not in SLICE_TRANSITIONS
		const result = handlePause(db, sliceId);
		expect(result.success).toBe(false);
	});
});
