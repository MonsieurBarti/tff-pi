import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validatePlan } from "../../../src/commands/plan.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("validatePlan", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = getSlices(db, milestoneId)[0]!.id;
	});

	it("succeeds for discussing status", () => {
		updateSliceStatus(db, sliceId, "discussing");
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("succeeds for researching status", () => {
		updateSliceStatus(db, sliceId, "researching");
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for created status", () => {
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("created");
	});

	it("fails for planning status", () => {
		updateSliceStatus(db, sliceId, "planning");
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("planning");
	});

	it("fails for executing status", () => {
		updateSliceStatus(db, sliceId, "executing");
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("executing");
	});

	it("fails for unknown slice id", () => {
		const result = validatePlan(db, "nonexistent");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Slice not found");
	});
});
