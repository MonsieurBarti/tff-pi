import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	openDatabase,
} from "../../../src/common/db.js";
import { handleCreateProject } from "../../../src/tools/create-project.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleCreateProject", () => {
	let db: Database.Database;
	let root: string;

	beforeEach(() => {
		db = createTestDb();
		root = mkdtempSync(join(tmpdir(), "tff-create-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a project with milestone and slices", () => {
		const result = handleCreateProject(db, root, {
			projectName: "TFF",
			vision: "Build great things",
			milestoneName: "Foundation",
			slices: ["Auth", "DB", "API"],
		});

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("TFF");
		expect(result.content[0]!.text).toContain("3 slice(s)");

		const project = getProject(db);
		expect(project).not.toBeNull();
		expect(project!.name).toBe("TFF");

		const milestones = getMilestones(db, project!.id);
		expect(milestones).toHaveLength(1);

		const slices = getSlices(db, milestones[0]!.id);
		expect(slices).toHaveLength(3);
	});

	it("returns error when project already exists", () => {
		handleCreateProject(db, root, {
			projectName: "TFF",
			vision: "Vision",
			milestoneName: "M01",
			slices: ["S1"],
		});

		const result = handleCreateProject(db, root, {
			projectName: "TFF2",
			vision: "Vision 2",
			milestoneName: "M01",
			slices: ["S1"],
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Project already exists");
	});
});
