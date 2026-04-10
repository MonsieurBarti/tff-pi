import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { handleHealth } from "../../../src/commands/health.js";
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

describe("handleHealth", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("reports no project when DB is empty", () => {
		const result = handleHealth(db);
		expect(result).toContain("no project found");
	});

	it("reports OK with project stats", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });

		const result = handleHealth(db);
		expect(result).toContain("OK");
		expect(result).toContain("TFF");
		expect(result).toContain("Milestones: 1");
		expect(result).toContain("Slices: 2");
	});
});
