import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	readArtifact,
} from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getDependencies,
	getMilestones,
	getProject,
	getSlices,
	getTasks,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { handleWritePlan } from "../../../src/tools/write-plan.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function createTempRoot(): string {
	return mkdtempSync(join(tmpdir(), "tff-write-plan-test-"));
}

describe("handleWritePlan", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		root = createTempRoot();
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = getSlices(db, milestoneId)[0]!.id;
		initSliceDir(root, 1, 1);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes PLAN.md and creates task records with waves", () => {
		const content = "# Plan\n\nTasks below.\n";
		const tasks = [
			{ title: "Setup DB", description: "Create schema" },
			{ title: "Add API", description: "REST endpoints", dependsOn: [1] },
			{ title: "Add UI", description: "Frontend", dependsOn: [2] },
		];

		const result = handleWritePlan(db, root, sliceId, content, tasks);

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("PLAN.md written for M01-S01");
		expect(result.content[0]!.text).toContain("3 task(s)");
		expect(result.content[0]!.text).toContain("3 wave(s)");
		expect(result.details.taskCount).toBe(3);
		expect(result.details.waveCount).toBe(3);

		const written = readArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md");
		expect(written).toBe(content);

		const dbTasks = getTasks(db, sliceId);
		expect(dbTasks).toHaveLength(3);
		expect(dbTasks[0]!.title).toBe("Setup DB");
		expect(dbTasks[0]!.wave).toBe(1);
		expect(dbTasks[1]!.title).toBe("Add API");
		expect(dbTasks[1]!.wave).toBe(2);
		expect(dbTasks[2]!.title).toBe("Add UI");
		expect(dbTasks[2]!.wave).toBe(3);
	});

	it("creates dependency records", () => {
		const tasks = [
			{ title: "Task A", description: "First" },
			{ title: "Task B", description: "Second", dependsOn: [1] },
		];

		handleWritePlan(db, root, sliceId, "# Plan\n", tasks);

		const deps = getDependencies(db, sliceId);
		expect(deps).toHaveLength(1);
		expect(deps[0]!.fromTaskId).toBeDefined();
		expect(deps[0]!.toTaskId).toBeDefined();
	});

	it("returns error for unknown slice", () => {
		const result = handleWritePlan(db, root, "nonexistent", "content", []);

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Slice not found");
	});

	it("handles tasks with no dependencies", () => {
		const tasks = [
			{ title: "Task A", description: "Independent" },
			{ title: "Task B", description: "Also independent" },
		];

		const result = handleWritePlan(db, root, sliceId, "# Plan\n", tasks);

		expect(result.isError).toBeUndefined();
		expect(result.details.waveCount).toBe(1);

		const dbTasks = getTasks(db, sliceId);
		expect(dbTasks).toHaveLength(2);
		expect(dbTasks[0]!.wave).toBe(1);
		expect(dbTasks[1]!.wave).toBe(1);
	});
});
