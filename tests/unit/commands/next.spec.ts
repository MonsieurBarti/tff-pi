import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validateNext } from "../../../src/commands/next.js";
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

describe("validateNext", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("fails with no project", () => {
		const result = validateNext(db);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("No active slice");
	});

	it("fails with no active slice", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const result = validateNext(db);
		expect(result.valid).toBe(false);
	});

	it("succeeds for created slice (discuss phase)", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });

		const result = validateNext(db);
		expect(result.valid).toBe(true);
		expect(result.phase).toBe("discuss");
		expect(result.sliceId).toBeDefined();
	});

	it("succeeds for discussing + SS slice (research phase)", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		updateSliceTier(db, sliceId, "SS");

		const result = validateNext(db);
		expect(result.valid).toBe(true);
		expect(result.phase).toBe("research");
	});

	it("succeeds for discussing + S slice (plan phase)", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		updateSliceTier(db, sliceId, "S");

		const result = validateNext(db);
		expect(result.valid).toBe(true);
		expect(result.phase).toBe("plan");
	});

	it("succeeds for planning slice (execute phase)", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sliceId);

		const result = validateNext(db);
		expect(result.valid).toBe(true);
		expect(result.phase).toBe("execute");
	});
});
