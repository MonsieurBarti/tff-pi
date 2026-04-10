import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validateResearch } from "../../../src/commands/research.js";
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
	updateSliceTier,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("validateResearch", () => {
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

	it("succeeds for discussing status with SS tier", () => {
		updateSliceStatus(db, sliceId, "discussing");
		updateSliceTier(db, sliceId, "SS");
		const result = validateResearch(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("succeeds for discussing status with SSS tier", () => {
		updateSliceStatus(db, sliceId, "discussing");
		updateSliceTier(db, sliceId, "SSS");
		const result = validateResearch(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for S-tier slice", () => {
		updateSliceStatus(db, sliceId, "discussing");
		updateSliceTier(db, sliceId, "S");
		const result = validateResearch(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("S-tier");
	});

	it("fails for created status", () => {
		const result = validateResearch(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("created");
	});

	it("fails for planning status", () => {
		updateSliceStatus(db, sliceId, "planning");
		const result = validateResearch(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("planning");
	});

	it("fails for unknown slice id", () => {
		const result = validateResearch(db, "nonexistent");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Slice not found");
	});
});
