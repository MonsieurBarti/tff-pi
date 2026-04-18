import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTffDirectory } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	openDatabase,
} from "../../../src/common/db.js";
import { handleCreateSlice } from "../../../src/tools/create-slice.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function createTempRoot(): string {
	return mkdtempSync(join(tmpdir(), "tff-create-slice-test-"));
}

describe("handleCreateSlice", () => {
	let db: Database.Database;
	let root: string;
	let milestoneId: string;

	beforeEach(() => {
		db = createTestDb();
		root = createTempRoot();
		mkdirSync(join(root, ".tff"), { recursive: true });
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a slice and returns success", () => {
		const result = handleCreateSlice(db, root, milestoneId, "Auth");

		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("M01-S01");
		expect(must(result.content[0]).text).toContain("Auth");
		expect(result.details.sliceId).toBeDefined();
		expect(result.details.label).toBe("M01-S01");
		expect(result.details.number).toBe(1);
	});

	it("auto-increments slice number", () => {
		handleCreateSlice(db, root, milestoneId, "Auth");
		const result = handleCreateSlice(db, root, milestoneId, "DB");

		expect(result.details.number).toBe(2);
		expect(result.details.label).toBe("M01-S02");

		const slices = getSlices(db, milestoneId);
		expect(slices).toHaveLength(2);
		expect(must(slices[0]).title).toBe("Auth");
		expect(must(slices[0]).number).toBe(1);
		expect(must(slices[1]).title).toBe("DB");
		expect(must(slices[1]).number).toBe(2);
	});

	it("creates slice directory", () => {
		handleCreateSlice(db, root, milestoneId, "Auth");

		const dirPath = join(root, ".tff", "milestones", "M01", "slices", "M01-S01");
		expect(existsSync(dirPath)).toBe(true);
	});

	it("returns error for invalid milestone", () => {
		const result = handleCreateSlice(db, root, "nonexistent", "Auth");

		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Milestone not found");
	});
});
