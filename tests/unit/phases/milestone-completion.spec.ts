import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getMilestone,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateMilestoneStatus,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		execFileSync: vi.fn().mockReturnValue("https://github.com/org/repo/pull/99\n"),
	};
});

vi.mock("../../../src/common/git.js", () => ({
	getDefaultBranch: vi.fn().mockReturnValue("main"),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake"),
	removeWorktree: vi.fn(),
}));

import { checkMilestoneCompletion } from "../../../src/phases/ship.js";

describe("checkMilestoneCompletion", () => {
	let db: Database.Database;
	let milestoneId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	it("transitions milestone to completing when all slices closed", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		for (const s of slices) {
			updateSliceStatus(db, s.id, "closed");
		}
		checkMilestoneCompletion(db, "/tmp", milestoneId, DEFAULT_SETTINGS);
		const milestone = must(getMilestone(db, milestoneId));
		expect(milestone.status).toBe("completing");
	});

	it("does nothing when some slices are not closed", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		updateSliceStatus(db, must(slices[0]).id, "closed");
		checkMilestoneCompletion(db, "/tmp", milestoneId, DEFAULT_SETTINGS);
		const milestone = must(getMilestone(db, milestoneId));
		expect(milestone.status).toBe("created");
	});

	it("does nothing when milestone is already completing", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const slices = getSlices(db, milestoneId);
		updateSliceStatus(db, must(slices[0]).id, "closed");
		updateMilestoneStatus(db, milestoneId, "completing");
		checkMilestoneCompletion(db, "/tmp", milestoneId, DEFAULT_SETTINGS);
		const milestone = must(getMilestone(db, milestoneId));
		expect(milestone.status).toBe("completing");
	});
});
