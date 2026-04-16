import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	countOpenSlicesInMilestone,
	exportState,
	getActiveMilestone,
	getActiveSlice,
	getDependencies,
	getMilestone,
	getMilestones,
	getNextMilestoneNumber,
	getNextSliceNumber,
	getProject,
	getSlice,
	getSlices,
	getTask,
	getTasks,
	getTasksByWave,
	insertDependency,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	resetTasksToOpen,
	updateMilestoneStatus,
	updatePhaseRun,
	updateSlicePrUrl,
	updateSliceTier,
	updateTaskStatus,
	updateTaskWave,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

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
		const project = must(getProject(db));
		expect(project.name).toBe("TFF");
		expect(project.vision).toBe("Make coding great");
		expect(project.id).toBeDefined();
		expect(project.createdAt).toBeDefined();
	});
});

describe("milestone", () => {
	let db: Database.Database;
	let projectId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		projectId = must(getProject(db)).id;
	});

	it("inserts and lists milestones for a project", () => {
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		insertMilestone(db, { projectId, number: 2, name: "Core", branch: "milestone/M02" });
		const milestones = getMilestones(db, projectId);
		expect(milestones).toHaveLength(2);
		expect(must(milestones[0]).name).toBe("Foundation");
		expect(must(milestones[0]).projectId).toBe(projectId);
		expect(must(milestones[0]).status).toBe("created");
	});

	it("gets a milestone by id", () => {
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestones = getMilestones(db, projectId);
		const id = must(milestones[0]).id;
		const m = must(getMilestone(db, id));
		expect(m.name).toBe("Foundation");
	});

	it("returns null for unknown id", () => {
		expect(getMilestone(db, "nonexistent")).toBeNull();
	});

	it("updates milestone status", () => {
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const id = must(getMilestones(db, projectId)[0]).id;
		updateMilestoneStatus(db, id, "in_progress");
		expect(must(getMilestone(db, id)).status).toBe("in_progress");
	});
});

describe("slice", () => {
	let db: Database.Database;
	let milestoneId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	it("inserts and lists slices for a milestone", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		expect(slices).toHaveLength(2);
		expect(must(slices[0]).title).toBe("Auth");
		expect(must(slices[0]).milestoneId).toBe(milestoneId);
		expect(must(slices[0]).status).toBe("created");
		expect(must(slices[0]).tier).toBeNull();
	});

	it("gets a slice by id", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const id = must(getSlices(db, milestoneId)[0]).id;
		const s = must(getSlice(db, id));
		expect(s.title).toBe("Auth");
	});

	it("returns null for unknown id", () => {
		expect(getSlice(db, "nonexistent")).toBeNull();
	});

	it("updates slice status", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const id = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", id);
		expect(must(getSlice(db, id)).status).toBe("executing");
	});

	it("updates slice tier", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const id = must(getSlices(db, milestoneId)[0]).id;
		updateSliceTier(db, id, "SS");
		expect(must(getSlice(db, id)).tier).toBe("SS");
	});
});

describe("task", () => {
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

	it("inserts and lists tasks for a slice", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		insertTask(db, { sliceId, number: 2, title: "Auth service", wave: 2 });
		const tasks = getTasks(db, sliceId);
		expect(tasks).toHaveLength(2);
		expect(must(tasks[0]).title).toBe("User entity");
		expect(must(tasks[0]).status).toBe("open");
		expect(must(tasks[0]).wave).toBeNull();
		expect(must(tasks[1]).wave).toBe(2);
	});

	it("gets a task by id", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		const id = must(getTasks(db, sliceId)[0]).id;
		const t = must(getTask(db, id));
		expect(t.title).toBe("User entity");
	});

	it("returns null for unknown id", () => {
		expect(getTask(db, "nonexistent")).toBeNull();
	});

	it("updates task status", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		const id = must(getTasks(db, sliceId)[0]).id;
		updateTaskStatus(db, id, "in_progress");
		expect(must(getTask(db, id)).status).toBe("in_progress");
		expect(must(getTask(db, id)).claimedBy).toBeNull();
	});

	it("updates task status with claimedBy", () => {
		insertTask(db, { sliceId, number: 1, title: "User entity" });
		const id = must(getTasks(db, sliceId)[0]).id;
		updateTaskStatus(db, id, "in_progress", "agent-007");
		expect(must(getTask(db, id)).claimedBy).toBe("agent-007");
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
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		insertTask(db, { sliceId, number: 1, title: "T1" });
		insertTask(db, { sliceId, number: 2, title: "T2" });
		const tasks = getTasks(db, sliceId);
		task1Id = must(tasks[0]).id;
		task2Id = must(tasks[1]).id;
	});

	it("inserts dependency and retrieves by sliceId", () => {
		insertDependency(db, { fromTaskId: task2Id, toTaskId: task1Id });
		const deps = getDependencies(db, sliceId);
		expect(deps).toHaveLength(1);
		expect(must(deps[0]).fromTaskId).toBe(task2Id);
		expect(must(deps[0]).toTaskId).toBe(task1Id);
	});

	it("returns empty array when no dependencies", () => {
		expect(getDependencies(db, sliceId)).toHaveLength(0);
	});
});

describe("exportState", () => {
	it("exports all data as JSON string", () => {
		const db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		insertTask(db, { sliceId, number: 1, title: "T1" });
		const taskId = must(getTasks(db, sliceId)[0]).id;
		insertTask(db, { sliceId, number: 2, title: "T2" });
		const task2Id = must(getTasks(db, sliceId)[1]).id;
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

describe("updateTaskWave", () => {
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

	it("sets the wave number on a task", () => {
		insertTask(db, { sliceId, number: 1, title: "T1" });
		const id = must(getTasks(db, sliceId)[0]).id;
		expect(must(getTask(db, id)).wave).toBeNull();
		updateTaskWave(db, id, 3);
		expect(must(getTask(db, id)).wave).toBe(3);
	});
});

describe("getNextMilestoneNumber", () => {
	let db: Database.Database;
	let projectId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		projectId = must(getProject(db)).id;
	});

	it("returns 1 when no milestones exist", () => {
		expect(getNextMilestoneNumber(db, projectId)).toBe(1);
	});

	it("returns next number after existing milestones", () => {
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		insertMilestone(db, { projectId, number: 2, name: "M2", branch: "milestone/M02" });
		expect(getNextMilestoneNumber(db, projectId)).toBe(3);
	});
});

describe("getActiveMilestone", () => {
	let db: Database.Database;
	let projectId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		projectId = must(getProject(db)).id;
	});

	it("returns null when no milestones exist", () => {
		expect(getActiveMilestone(db, projectId)).toBeNull();
	});

	it("returns the first non-closed milestone", () => {
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		insertMilestone(db, { projectId, number: 2, name: "M2", branch: "milestone/M02" });
		const m1Id = must(getMilestones(db, projectId)[0]).id;
		updateMilestoneStatus(db, m1Id, "closed");
		const active = must(getActiveMilestone(db, projectId));
		expect(active.name).toBe("M2");
	});
});

describe("getNextSliceNumber", () => {
	let db: Database.Database;
	let milestoneId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	it("returns 1 when no slices exist", () => {
		expect(getNextSliceNumber(db, milestoneId)).toBe(1);
	});

	it("returns next number after existing slices", () => {
		insertSlice(db, { milestoneId, number: 1, title: "S1" });
		insertSlice(db, { milestoneId, number: 2, title: "S2" });
		expect(getNextSliceNumber(db, milestoneId)).toBe(3);
	});
});

describe("getActiveSlice", () => {
	let db: Database.Database;
	let milestoneId: string;

	beforeEach(() => {
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	it("returns null when no slices exist", () => {
		expect(getActiveSlice(db, milestoneId)).toBeNull();
	});

	it("returns the first non-closed slice", () => {
		insertSlice(db, { milestoneId, number: 1, title: "S1" });
		insertSlice(db, { milestoneId, number: 2, title: "S2" });
		const s1Id = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", s1Id);
		const active = must(getActiveSlice(db, milestoneId));
		expect(active.title).toBe("S2");
	});
});

describe("pr_url column", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	});
	it("slice has null pr_url by default", () => {
		const projectId = must(getProject(db)).id;
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const slice = must(getSlices(db, milestoneId)[0]);
		expect(slice.prUrl).toBeNull();
	});
	it("updateSlicePrUrl sets the PR URL", () => {
		const projectId = must(getProject(db)).id;
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		const slice = must(getSlice(db, sliceId));
		expect(slice.prUrl).toBe("https://github.com/org/repo/pull/42");
	});
});

describe("getTasksByWave", () => {
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
	it("returns tasks grouped by wave number", () => {
		const t1 = insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const t2 = insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		const t3 = insertTask(db, { sliceId, number: 3, title: "API", wave: 2 });
		const grouped = getTasksByWave(db, sliceId);
		expect(grouped.get(1)?.map((t) => t.id)).toEqual([t1, t2]);
		expect(grouped.get(2)?.map((t) => t.id)).toEqual([t3]);
	});
	it("returns empty map for slice with no tasks", () => {
		const grouped = getTasksByWave(db, sliceId);
		expect(grouped.size).toBe(0);
	});
});

describe("resetTasksToOpen", () => {
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
	it("resets all tasks in a slice to open with null claimedBy", () => {
		const t1Id = insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const t2Id = insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		updateTaskStatus(db, t1Id, "closed", "agent-1");
		updateTaskStatus(db, t2Id, "in_progress", "agent-2");
		resetTasksToOpen(db, sliceId);
		const tasks = getTasks(db, sliceId);
		for (const t of tasks) {
			expect(t.status).toBe("open");
			expect(t.claimedBy).toBeNull();
		}
	});
});

describe("insertPhaseRun — duplicate-started guard", () => {
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

	it("returns existing id when a started row exists for same (sliceId, phase)", () => {
		const first = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		const second = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		expect(second).toBe(first);
		const rows = db
			.prepare("SELECT COUNT(*) as c FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(sliceId, "execute") as { c: number };
		expect(rows.c).toBe(1);
	});

	it("still inserts when status is 'completed' or 'failed'", () => {
		const firstId = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, firstId, {
			status: "completed",
			finishedAt: new Date().toISOString(),
		});
		const secondId = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		expect(secondId).not.toBe(firstId);
		const rows = db
			.prepare("SELECT COUNT(*) as c FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(sliceId, "execute") as { c: number };
		expect(rows.c).toBe(2);
	});
});

describe("insertProject with explicit id", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
	});

	it("round-trips a provided id as project.id", () => {
		const id = randomUUID();
		const returned = insertProject(db, { name: "X", vision: "V", id });
		expect(returned).toBe(id);
		const proj = getProject(db);
		expect(proj?.id).toBe(id);
	});

	it("generates a random UUID when id is omitted", () => {
		const returned = insertProject(db, { name: "X", vision: "V" });
		expect(returned).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	});
});

describe("countOpenSlicesInMilestone", () => {
	it("returns 0 for a milestone with no slices", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		expect(countOpenSlicesInMilestone(db, milestoneId)).toBe(0);
	});

	it("returns the count of slices whose status is not 'closed'", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "S1" });
		insertSlice(db, { milestoneId, number: 2, title: "S2" });
		insertSlice(db, { milestoneId, number: 3, title: "S3" });
		const slices = getSlices(db, milestoneId);
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(must(slices[0]).id);
		expect(countOpenSlicesInMilestone(db, milestoneId)).toBe(2);
	});

	it("returns 0 when every slice is closed", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "S1" });
		const slice = must(getSlices(db, milestoneId)[0]);
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(slice.id);
		expect(countOpenSlicesInMilestone(db, milestoneId)).toBe(0);
	});
});
