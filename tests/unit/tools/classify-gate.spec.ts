import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
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
import { resetGates, unlockGate } from "../../../src/common/discuss-gates.js";
import { handleClassify } from "../../../src/tools/classify.js";
import { must } from "../../helpers.js";

describe("classify gate", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);

		insertProject(db, { name: "Test", vision: "Test vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "main" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Test Slice" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;

		resetGates(sliceId);
	});

	it("rejects classify when tier_confirmed gate is locked", () => {
		const result = handleClassify(db, sliceId, "SS");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Tier must be confirmed");
	});

	it("allows classify when tier_confirmed gate is unlocked", () => {
		unlockGate(sliceId, "tier_confirmed");
		const result = handleClassify(db, sliceId, "SS");
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("classified as Tier SS");
	});

	it("enforces gate always (no headless bypass)", () => {
		const result = handleClassify(db, sliceId, "SS");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Tier must be confirmed");
	});
});
