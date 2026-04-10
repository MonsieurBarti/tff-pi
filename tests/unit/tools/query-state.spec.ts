import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	getTasks,
	insertDependency,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
} from "../../../src/common/db.js";
import { queryState } from "../../../src/tools/query-state.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("queryState overview", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("returns null project and empty milestones on empty DB", () => {
		const result = queryState(db, "overview");
		expect(result.project).toBeNull();
		expect(result.milestones).toEqual([]);
	});

	it("returns project and all milestones", () => {
		insertProject(db, { name: "TFF", vision: "Make coding great" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		insertMilestone(db, { projectId, number: 2, name: "Core", branch: "milestone/M02" });

		const result = queryState(db, "overview");
		expect(result.project).not.toBeNull();
		expect(must(result.project).name).toBe("TFF");
		expect(result.milestones).toHaveLength(2);
		expect(must(result.milestones[0]).name).toBe("Foundation");
		expect(must(result.milestones[1]).name).toBe("Core");
	});

	it("returns project with no milestones when none exist", () => {
		insertProject(db, { name: "TFF", vision: "Make coding great" });

		const result = queryState(db, "overview");
		expect(result.project).not.toBeNull();
		expect(result.milestones).toEqual([]);
	});
});

describe("queryState milestone", () => {
	let db: Database.Database;
	let milestoneId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	it("returns null milestone and empty slices for unknown id", () => {
		const result = queryState(db, "milestone", "nonexistent");
		expect(result.milestone).toBeNull();
		expect(result.slices).toEqual([]);
	});

	it("returns milestone and its slices", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });

		const result = queryState(db, "milestone", milestoneId);
		expect(result.milestone).not.toBeNull();
		expect(must(result.milestone).name).toBe("Foundation");
		expect(result.slices).toHaveLength(2);
		expect(must(result.slices[0]).title).toBe("Auth");
		expect(must(result.slices[1]).title).toBe("DB");
	});

	it("returns milestone with no slices when none exist", () => {
		const result = queryState(db, "milestone", milestoneId);
		expect(result.milestone).not.toBeNull();
		expect(result.slices).toEqual([]);
	});
});

describe("queryState slice", () => {
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

	it("returns null slice, empty tasks, and empty dependencies for unknown id", () => {
		const result = queryState(db, "slice", "nonexistent");
		expect(result.slice).toBeNull();
		expect(result.tasks).toEqual([]);
		expect(result.dependencies).toEqual([]);
	});

	it("returns slice and its tasks", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		insertTask(db, { sliceId, number: 2, title: "Auth service", wave: 2 });

		const result = queryState(db, "slice", sliceId);
		expect(result.slice).not.toBeNull();
		expect(must(result.slice).title).toBe("Auth");
		expect(result.tasks).toHaveLength(2);
		expect(must(result.tasks[0]).title).toBe("User entity");
		expect(must(result.tasks[1]).title).toBe("Auth service");
	});

	it("returns slice with tasks and dependencies", () => {
		insertTask(db, { sliceId, number: 1, title: "T1" });
		insertTask(db, { sliceId, number: 2, title: "T2" });
		insertTask(db, { sliceId, number: 3, title: "T3" });
		const tasks = getTasks(db, sliceId);
		const t1Id = must(tasks[0]).id;
		const t2Id = must(tasks[1]).id;
		const t3Id = must(tasks[2]).id;

		insertDependency(db, { fromTaskId: t2Id, toTaskId: t1Id });
		insertDependency(db, { fromTaskId: t3Id, toTaskId: t2Id });

		const result = queryState(db, "slice", sliceId);
		expect(result.slice).not.toBeNull();
		expect(result.tasks).toHaveLength(3);
		expect(result.dependencies).toHaveLength(2);
		const depPairs = result.dependencies.map((d) => ({
			from: d.fromTaskId,
			to: d.toTaskId,
		}));
		expect(depPairs).toContainEqual({ from: t2Id, to: t1Id });
		expect(depPairs).toContainEqual({ from: t3Id, to: t2Id });
	});

	it("returns empty dependencies when none exist", () => {
		insertTask(db, { sliceId, number: 1, title: "T1" });

		const result = queryState(db, "slice", sliceId);
		expect(result.dependencies).toEqual([]);
	});
});
