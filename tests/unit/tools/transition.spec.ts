import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
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
import { handleTransition } from "../../../src/tools/transition.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleTransition", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("returns error for non-existent slice", () => {
		const result = handleTransition(db, "nonexistent");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Slice not found");
	});

	it("auto-advances to next status when targetStatus omitted", () => {
		const result = handleTransition(db, sliceId);
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("created → discussing");
		expect(must(getSlice(db, sliceId)).status).toBe("discussing");
	});

	it("transitions to explicit valid targetStatus", () => {
		updateSliceStatus(db, sliceId, "discussing");
		const result = handleTransition(db, sliceId, "researching");
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("discussing → researching");
	});

	it("returns error for invalid targetStatus string", () => {
		const result = handleTransition(db, sliceId, "bogus_status");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Invalid status: bogus_status");
	});

	it("returns error for disallowed transition", () => {
		const result = handleTransition(db, sliceId, "closed");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Invalid transition");
		expect(must(result.content[0]).text).toContain("Allowed from 'created': discussing");
	});

	it("returns error when no next status from closed", () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = handleTransition(db, sliceId);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("No valid next status");
	});
});
