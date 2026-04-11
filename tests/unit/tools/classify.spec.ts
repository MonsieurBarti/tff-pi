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
import { must } from "../../helpers.js";

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
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("returns error for non-existent slice", () => {
		const result = handleClassify(db, "nonexistent", "S", { headless: true });
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Slice not found");
	});

	it("classifies a slice as S tier", () => {
		const result = handleClassify(db, sliceId, "S", { headless: true });
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("Tier S");
		expect(must(getSlice(db, sliceId)).tier).toBe("S");
	});

	it("classifies a slice as SS tier", () => {
		const result = handleClassify(db, sliceId, "SS", { headless: true });
		expect(result.isError).toBeUndefined();
		expect(must(getSlice(db, sliceId)).tier).toBe("SS");
	});

	it("classifies a slice as SSS tier", () => {
		const result = handleClassify(db, sliceId, "SSS", { headless: true });
		expect(result.isError).toBeUndefined();
		expect(must(getSlice(db, sliceId)).tier).toBe("SSS");
	});

	it("reclassifies an already-classified slice", () => {
		handleClassify(db, sliceId, "S", { headless: true });
		expect(must(getSlice(db, sliceId)).tier).toBe("S");
		handleClassify(db, sliceId, "SSS", { headless: true });
		expect(must(getSlice(db, sliceId)).tier).toBe("SSS");
	});
});
