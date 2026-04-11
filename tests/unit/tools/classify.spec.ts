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
import { unlockGate } from "../../../src/common/discuss-gates.js";
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
		unlockGate("nonexistent", "tier_confirmed");
		const result = handleClassify(db, "nonexistent", "S");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Slice not found");
	});

	it("classifies a slice as S tier", () => {
		unlockGate(sliceId, "tier_confirmed");
		const result = handleClassify(db, sliceId, "S");
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("Tier S");
		expect(must(getSlice(db, sliceId)).tier).toBe("S");
	});

	it("classifies a slice as SS tier", () => {
		unlockGate(sliceId, "tier_confirmed");
		const result = handleClassify(db, sliceId, "SS");
		expect(result.isError).toBeUndefined();
		expect(must(getSlice(db, sliceId)).tier).toBe("SS");
	});

	it("classifies a slice as SSS tier", () => {
		unlockGate(sliceId, "tier_confirmed");
		const result = handleClassify(db, sliceId, "SSS");
		expect(result.isError).toBeUndefined();
		expect(must(getSlice(db, sliceId)).tier).toBe("SSS");
	});

	it("reclassifies an already-classified slice", () => {
		unlockGate(sliceId, "tier_confirmed");
		handleClassify(db, sliceId, "S");
		expect(must(getSlice(db, sliceId)).tier).toBe("S");
		handleClassify(db, sliceId, "SSS");
		expect(must(getSlice(db, sliceId)).tier).toBe("SSS");
	});
});
