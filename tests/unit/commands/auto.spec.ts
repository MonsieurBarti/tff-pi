import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validateAuto } from "../../../src/commands/auto.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("validateAuto", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("fails with no project", () => {
		const result = validateAuto(db);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("No active slice");
	});

	it("fails with no active slice", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const result = validateAuto(db);
		expect(result.valid).toBe(false);
	});

	it("succeeds with an active slice", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });

		const result = validateAuto(db);
		expect(result.valid).toBe(true);
		expect(result.sliceId).toBeDefined();
	});
});
