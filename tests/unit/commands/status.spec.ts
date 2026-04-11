import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { handleStatus } from "../../../src/commands/status.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	updatePhaseRun,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

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
		const project = must(getProject(db));
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
		const project = must(getProject(db));
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
		const project = must(getProject(db));
		insertMilestone(db, {
			projectId: project.id,
			number: 1,
			name: "Foundation",
			branch: "milestone/M01",
		});
		const milestones = getMilestones(db, project.id);
		insertSlice(db, { milestoneId: must(milestones[0]).id, number: 1, title: "Auth" });

		const result = handleStatus(db);
		expect(result).toContain("M01-S01");
		expect(result).toContain("Auth");
		expect(result).toContain("created");
	});

	it("suggests next action for the first non-closed slice in created status", () => {
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

		const result = handleStatus(db);
		expect(result).toContain("/tff discuss M01-S01");
	});

	it("shows phase run info when monitoring data exists", () => {
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

		const runId1 = insertPhaseRun(db, {
			sliceId,
			phase: "research",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId1, {
			status: "completed",
			finishedAt: new Date().toISOString(),
			durationMs: 5000,
		});

		const runId2 = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "running",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId2, { status: "running" });

		const result = handleStatus(db);
		expect(result).toContain("1/2 phases");
		expect(result).toContain("5s total");
	});
});
