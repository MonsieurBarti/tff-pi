import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validateDiscuss } from "../../../src/commands/discuss.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
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

describe("validateDiscuss", () => {
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

	it("succeeds for created status", () => {
		const result = validateDiscuss(db, sliceId);
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("succeeds for discussing status (re-run stuck phase)", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		const result = validateDiscuss(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for executing status", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sliceId);
		const result = validateDiscuss(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("executing");
	});

	it("fails for closed status", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", sliceId);
		const result = validateDiscuss(db, sliceId);
		expect(result.valid).toBe(false);
	});

	it("fails for unknown slice id", () => {
		const result = validateDiscuss(db, "nonexistent");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Slice not found");
	});
});
