import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validateExecute } from "../../../src/commands/execute.js";
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

describe("validateExecute", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("succeeds when slice is in planning status", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sliceId);
		const result = validateExecute(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("succeeds when slice is in executing status (re-run stuck phase)", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sliceId);
		const result = validateExecute(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for wrong status", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		const result = validateExecute(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("planning");
	});

	it("fails for unknown slice", () => {
		const result = validateExecute(db, "nonexistent");
		expect(result.valid).toBe(false);
	});
});
