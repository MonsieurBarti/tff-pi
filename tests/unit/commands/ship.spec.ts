import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { validateShip } from "../../../src/commands/ship.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

describe("validateShip", () => {
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

	it("succeeds when slice is in reviewing status", () => {
		updateSliceStatus(db, sliceId, "reviewing");
		const result = validateShip(db, sliceId);
		expect(result.valid).toBe(true);
	});

	it("fails for wrong status", () => {
		updateSliceStatus(db, sliceId, "executing");
		const result = validateShip(db, sliceId);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("reviewing");
	});

	it("fails for unknown slice", () => {
		const result = validateShip(db, "nonexistent");
		expect(result.valid).toBe(false);
	});
});
