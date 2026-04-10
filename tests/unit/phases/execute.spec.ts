import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	getTask,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceStatus,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

const mockDispatch = vi.fn().mockResolvedValue({ success: true, output: "done" });
vi.mock("../../../src/common/dispatch.js", () => ({
	dispatchSubAgent: (...args: unknown[]) => mockDispatch(...args),
	buildSubagentTask: vi.fn().mockReturnValue("task"),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	createWorktree: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	worktreeExists: vi.fn().mockReturnValue(false),
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
}));

import { executePhase } from "../../../src/phases/execute.js";

describe("executePhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		mockDispatch.mockResolvedValue({ success: true, output: "done" });
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-exec-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceStatus(db, sliceId, "planning");
		updateSliceTier(db, sliceId, "SS");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof executePhase.run).toBe("function");
	});

	it("dispatches agents for each task in wave order", async () => {
		const t1 = insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const t2 = insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		const t3 = insertTask(db, { sliceId, number: 3, title: "API", wave: 2 });

		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {} as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.run(ctx);
		expect(result.success).toBe(true);
		expect(must(getTask(db, t1)).status).toBe("closed");
		expect(must(getTask(db, t2)).status).toBe("closed");
		expect(must(getTask(db, t3)).status).toBe("closed");
	});

	it("aborts if a wave task fails after retries", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const t2 = insertTask(db, { sliceId, number: 2, title: "Broken", wave: 1 });

		mockDispatch
			.mockResolvedValueOnce({ success: true, output: "done" })
			.mockResolvedValue({ success: false, output: "error" });

		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {} as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.run(ctx);
		expect(result.success).toBe(false);
		expect(must(getTask(db, t2)).status).toBe("in_progress");
	});

	it("returns success with no tasks", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {} as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.run(ctx);
		expect(result.success).toBe(true);
	});
});
