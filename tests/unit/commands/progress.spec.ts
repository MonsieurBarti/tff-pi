import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { handleProgress } from "../../../src/commands/progress.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	getTasks,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	updatePhaseRun,
	updateTaskStatus,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = new Database(":memory:");
	applyMigrations(db);
	return db;
}

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
		const project = must(getProject(db));
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
		const project = must(getProject(db));
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 2, title: "DB" });

		const result = handleProgress(db);
		expect(result).toContain("M01");
		expect(result).toContain("Foundation");
		expect(result).toContain("0/2");
	});

	it("shows slice table with em-dash when no tasks exist", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = must(getProject(db));
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 1, title: "Auth" });

		const result = handleProgress(db);
		expect(result).toContain("M01-S01");
		expect(result).toContain("Auth");
		expect(result).toContain("—");
	});

	it("shows closed/total task counts when tasks exist", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = must(getProject(db));
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 1, title: "Auth" });
		const slices = getSlices(db, must(milestones[0]).id);
		insertTask(db, { sliceId: must(slices[0]).id, number: 1, title: "Task 1" });
		insertTask(db, { sliceId: must(slices[0]).id, number: 2, title: "Task 2" });
		const tasks = getTasks(db, must(slices[0]).id);
		updateTaskStatus(db, must(tasks[0]).id, "closed");

		const result = handleProgress(db);
		expect(result).toContain("1/2");
	});

	it("shows Phases and Time columns in table", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = must(getProject(db));
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 1, title: "Auth" });
		const slices = getSlices(db, must(milestones[0]).id);
		const sliceId = must(slices[0]).id;

		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, {
			status: "completed",
			finishedAt: new Date().toISOString(),
			durationMs: 90000,
		});

		const result = handleProgress(db);
		expect(result).toContain("Phases");
		expect(result).toContain("Time");
		// 1 distinct completed phase / 7 expected (null tier → full pipeline)
		expect(result).toContain("1/7");
		expect(result).toContain("1m30s");
		expect(result).toContain("Pipeline:");
		expect(result).toContain("elapsed");
	});

	it("does not inflate numerator when a phase is retried", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const project = must(getProject(db));
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 1, title: "Auth" });
		const slices = getSlices(db, must(milestones[0]).id);
		const sliceId = must(slices[0]).id;
		// Set S tier so denominator is 6
		db.prepare("UPDATE slice SET tier = 'S' WHERE id = ?").run(sliceId);

		// Simulate execute retried twice — only 1 distinct completed phase
		const run1Id = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, run1Id, {
			status: "completed",
			finishedAt: new Date().toISOString(),
			durationMs: 1000,
		});
		const run2Id = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, run2Id, {
			status: "completed",
			finishedAt: new Date().toISOString(),
			durationMs: 1000,
		});

		const result = handleProgress(db);
		// 1 distinct completed phase (execute, deduplicated) / 6 expected for S tier
		expect(result).toContain("1/6");
		expect(result).not.toContain("2/6");
	});
});
