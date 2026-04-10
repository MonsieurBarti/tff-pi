import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	exportState,
	getDependencies,
	getMilestone,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	getTask,
	getTasks,
	insertDependency,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateMilestoneStatus,
	updateSliceStatus,
	updateSliceTier,
	updateTaskStatus,
} from "../../../src/common/db.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("applyMigrations", () => {
	it("creates all tables", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toContain("project");
		expect(names).toContain("milestone");
		expect(names).toContain("slice");
		expect(names).toContain("task");
		expect(names).toContain("dependency");
	});

	it("is idempotent — can be called twice without error", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		expect(() => applyMigrations(db)).not.toThrow();
	});
});

describe("project", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("returns null when no project exists", () => {
		expect(getProject(db)).toBeNull();
	});

	it("inserts and retrieves a project", () => {
		insertProject(db, { name: "TFF", vision: "Make coding great" });
		const project = getProject(db);
		expect(project).not.toBeNull();
		expect(project!.name).toBe("TFF");
		expect(project!.vision).toBe("Make coding great");
		expect(project!.id).toBeDefined();
		expect(project!.createdAt).toBeDefined();
	});
});

describe("milestone", () => {
	let db: Database.Database;
	let projectId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		projectId = getProject(db)!.id;
	});

	it("inserts and lists milestones for a project", () => {
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		insertMilestone(db, { projectId, number: 2, name: "Core", branch: "milestone/M02" });
		const milestones = getMilestones(db, projectId);
		expect(milestones).toHaveLength(2);
		expect(milestones[0]!.name).toBe("Foundation");
		expect(milestones[0]!.projectId).toBe(projectId);
		expect(milestones[0]!.status).toBe("created");
	});

	it("gets a milestone by id", () => {
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestones = getMilestones(db, projectId);
		const id = milestones[0]!.id;
		const m = getMilestone(db, id);
		expect(m).not.toBeNull();
		expect(m!.name).toBe("Foundation");
	});

	it("returns null for unknown id", () => {
		expect(getMilestone(db, "nonexistent")).toBeNull();
	});

	it("updates milestone status", () => {
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const id = getMilestones(db, projectId)[0]!.id;
		updateMilestoneStatus(db, id, "in_progress");
		expect(getMilestone(db, id)!.status).toBe("in_progress");
	});
});

describe("slice", () => {
	let db: Database.Database;
	let milestoneId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = getMilestones(db, projectId)[0]!.id;
	});

	it("inserts and lists slices for a milestone", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		expect(slices).toHaveLength(2);
		expect(slices[0]!.title).toBe("Auth");
		expect(slices[0]!.milestoneId).toBe(milestoneId);
		expect(slices[0]!.status).toBe("created");
		expect(slices[0]!.tier).toBeNull();
	});

	it("gets a slice by id", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const id = getSlices(db, milestoneId)[0]!.id;
		const s = getSlice(db, id);
		expect(s).not.toBeNull();
		expect(s!.title).toBe("Auth");
	});

	it("returns null for unknown id", () => {
		expect(getSlice(db, "nonexistent")).toBeNull();
	});

	it("updates slice status", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const id = getSlices(db, milestoneId)[0]!.id;
		updateSliceStatus(db, id, "executing");
		expect(getSlice(db, id)!.status).toBe("executing");
	});

	it("updates slice tier", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const id = getSlices(db, milestoneId)[0]!.id;
		updateSliceTier(db, id, "SS");
		expect(getSlice(db, id)!.tier).toBe("SS");
	});
});

describe("task", () => {
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

	it("inserts and lists tasks for a slice", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		insertTask(db, { sliceId, number: 2, title: "Auth service", wave: 2 });
		const tasks = getTasks(db, sliceId);
		expect(tasks).toHaveLength(2);
		expect(tasks[0]!.title).toBe("User entity");
		expect(tasks[0]!.status).toBe("open");
		expect(tasks[0]!.wave).toBeNull();
		expect(tasks[1]!.wave).toBe(2);
	});

	it("gets a task by id", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		const id = getTasks(db, sliceId)[0]!.id;
		const t = getTask(db, id);
		expect(t).not.toBeNull();
		expect(t!.title).toBe("User entity");
	});

	it("returns null for unknown id", () => {
		expect(getTask(db, "nonexistent")).toBeNull();
	});

	it("updates task status", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		const id = getTasks(db, sliceId)[0]!.id;
		updateTaskStatus(db, id, "in_progress");
		expect(getTask(db, id)!.status).toBe("in_progress");
		expect(getTask(db, id)!.claimedBy).toBeNull();
	});

	it("updates task status with claimedBy", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		const id = getTasks(db, sliceId)[0]!.id;
		updateTaskStatus(db, id, "in_progress", "agent-007");
		expect(getTask(db, id)!.claimedBy).toBe("agent-007");
	});
});

describe("dependency", () => {
	let db: Database.Database;
	let sliceId: string;
	let task1Id: string;
	let task2Id: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = getSlices(db, milestoneId)[0]!.id;
		insertTask(db, { sliceId, number: 1, title: "T1" });
		insertTask(db, { sliceId, number: 2, title: "T2" });
		const tasks = getTasks(db, sliceId);
		task1Id = tasks[0]!.id;
		task2Id = tasks[1]!.id;
	});

	it("inserts dependency and retrieves by sliceId", () => {
		insertDependency(db, { fromTaskId: task2Id, toTaskId: task1Id });
		const deps = getDependencies(db, sliceId);
		expect(deps).toHaveLength(1);
		expect(deps[0]!.fromTaskId).toBe(task2Id);
		expect(deps[0]!.toTaskId).toBe(task1Id);
	});

	it("returns empty array when no dependencies", () => {
		expect(getDependencies(db, sliceId)).toHaveLength(0);
	});
});

describe("exportState", () => {
	it("exports all data as JSON string", () => {
		const db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = getSlices(db, milestoneId)[0]!.id;
		insertTask(db, { sliceId, number: 1, title: "T1" });
		const taskId = getTasks(db, sliceId)[0]!.id;
		insertTask(db, { sliceId, number: 2, title: "T2" });
		const task2Id = getTasks(db, sliceId)[1]!.id;
		insertDependency(db, { fromTaskId: task2Id, toTaskId: taskId });

		const json = exportState(db);
		const state = JSON.parse(json);
		expect(state.projects).toHaveLength(1);
		expect(state.milestones).toHaveLength(1);
		expect(state.slices).toHaveLength(1);
		expect(state.tasks).toHaveLength(2);
		expect(state.dependencies).toHaveLength(1);
	});
});
