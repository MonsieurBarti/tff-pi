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
	updateSliceTier,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

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
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("succeeds for a discussing S-tier slice", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		updateSliceTier(db, sliceId, "S");
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for a discussing non-S-tier slice", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		updateSliceTier(db, sliceId, "SS");
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("non-S-tier must complete research first");
	});

	it("fails for a discussing slice with no tier", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("discussing");
	});

	it("succeeds for researching status", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("researching", sliceId);
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for created status", () => {
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("created");
	});

	it("succeeds for planning status (re-run stuck phase)", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sliceId);
		const result = validatePlan(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for executing status", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sliceId);
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
