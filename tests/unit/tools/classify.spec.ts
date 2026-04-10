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
} from "../../../src/common/db.js";
import { handleClassify } from "../../../src/tools/classify.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleClassify", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = getSlices(db, milestoneId)[0]!.id;
	});

	it("returns error for non-existent slice", () => {
		const result = handleClassify(db, "nonexistent", "S");
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Slice not found");
	});

	it("classifies a slice as S tier", () => {
		const result = handleClassify(db, sliceId, "S");
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("Tier S");
		expect(getSlice(db, sliceId)!.tier).toBe("S");
	});

	it("classifies a slice as SS tier", () => {
		const result = handleClassify(db, sliceId, "SS");
		expect(result.isError).toBeUndefined();
		expect(getSlice(db, sliceId)!.tier).toBe("SS");
	});

	it("classifies a slice as SSS tier", () => {
		const result = handleClassify(db, sliceId, "SSS");
		expect(result.isError).toBeUndefined();
		expect(getSlice(db, sliceId)!.tier).toBe("SSS");
	});

	it("reclassifies an already-classified slice", () => {
		handleClassify(db, sliceId, "S");
		expect(getSlice(db, sliceId)!.tier).toBe("S");
		handleClassify(db, sliceId, "SSS");
		expect(getSlice(db, sliceId)!.tier).toBe("SSS");
	});
});
