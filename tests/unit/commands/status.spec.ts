import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { handleProgress } from "../../../src/commands/progress.js";
import { handleStatus } from "../../../src/commands/status.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	getTasks,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	updateTaskStatus,
} from "../../../src/common/db.js";

function createTestDb(): Database.Database {
	const db = new Database(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleStatus", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("returns no-project message when no project exists", () => {
		const result = handleStatus(db);
		expect(result).toBe("No project found. Run `/tff new` to create one.");
	});

	it("shows project name as heading", () => {
		insertProject(db, { name: "MyProject", vision: "Build something great" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});

		const result = handleStatus(db);
		expect(result).toContain("MyProject");
	});

	it("shows milestones with label, name, and status", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});

		const result = handleStatus(db);
		expect(result).toContain("M01");
		expect(result).toContain("Foundation");
		expect(result).toContain("created");
	});

	it("shows slices with label, title, and status", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: milestones[0]!.id, number: 1, title: "Auth" });

		const result = handleStatus(db);
		expect(result).toContain("M01-S01");
		expect(result).toContain("Auth");
		expect(result).toContain("created");
	});

	it("suggests next action for the first non-closed slice in created status", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: milestones[0]!.id, number: 1, title: "Auth" });

		const result = handleStatus(db);
		expect(result).toContain("/tff discuss M01-S01");
	});
});

describe("handleProgress", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("returns no-project message when no project exists", () => {
		const result = handleProgress(db);
		expect(result).toBe("No project found. Run `/tff new` to create one.");
	});

	it("shows project name and Progress heading", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});

		const result = handleProgress(db);
		expect(result).toContain("TFF");
		expect(result).toContain("Progress");
	});

	it("shows milestone with closed/total slice counts", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: milestones[0]!.id, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId: milestones[0]!.id, number: 2, title: "DB" });

		const result = handleProgress(db);
		expect(result).toContain("M01");
		expect(result).toContain("Foundation");
		expect(result).toContain("0/2");
	});

	it("shows slice table with em-dash when no tasks exist", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: milestones[0]!.id, number: 1, title: "Auth" });

		const result = handleProgress(db);
		expect(result).toContain("M01-S01");
		expect(result).toContain("Auth");
		expect(result).toContain("—");
	});

	it("shows closed/total task counts when tasks exist", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = getProject(db)!;
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: milestones[0]!.id, number: 1, title: "Auth" });
		const slices = getSlices(db, milestones[0]!.id);
		insertTask(db, { sliceId: slices[0]!.id, number: 1, title: "Task 1" });
		insertTask(db, { sliceId: slices[0]!.id, number: 2, title: "Task 2" });
		const tasks = getTasks(db, slices[0]!.id);
		updateTaskStatus(db, tasks[0]!.id, "closed");

		const result = handleProgress(db);
		expect(result).toContain("1/2");
	});
});
