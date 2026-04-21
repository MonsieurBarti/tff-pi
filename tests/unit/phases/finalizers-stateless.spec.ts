import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn(() => "/tmp/fake-worktree"),
}));

vi.mock("../../../src/common/checkpoint.js", () => ({
	createCheckpoint: vi.fn(),
}));

vi.mock("../../../src/common/git.js", () => ({
	getTrackedDirtyEntries: vi.fn().mockReturnValue([]),
}));

vi.mock("../../../src/common/branch-naming.js", () => ({
	milestoneBranchName: vi.fn().mockReturnValue("milestone/abcdef01"),
}));
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	getTask,
	getTasks,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import {
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../../src/common/subagent-dispatcher.js";
import { registerPhaseFinalizers } from "../../../src/phases/finalizers.js";
import { must } from "../../helpers.js";

// The whole point of the stateless-finalizer refactor: finalizer must work
// when it runs in a session that never called prepare() — simulating PI's
// newSession() module isolation. We never call prepare() in these tests.

describe("stateless finalizers — module-isolation survival regression", () => {
	it("review finalizer reconstructs slice/milestone/worktree solely from config.sliceId + DB + disk", async () => {
		__resetFinalizersForTest();
		registerPhaseFinalizers();

		const db = openDatabase(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-stateless-review-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceTier(db, sliceId, "SS");
		db.prepare("UPDATE slice SET status = 'reviewing' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "review",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const pi = {
			events: {
				emit: (ch: string, ev: unknown) => {
					if (ch === "tff:phase") emitted.push(ev as { type: string; [k: string]: unknown });
				},
				on: () => {},
			},
			sendUserMessage: () => {},
		};

		// Point finalizer at a worktree path with no REVIEW.md on disk — the
		// finalizer must still fail cleanly (missing REVIEW.md) without needing
		// any closure state from prepare().
		const finalizer = __getFinalizerForTest("review");
		expect(finalizer).toBeDefined();
		if (!finalizer) return;

		await finalizer({
			pi: pi as never,
			db,
			root,
			settings: DEFAULT_SETTINGS,
			config: { mode: "single", phase: "review", sliceId, tasks: [] },
			result: {
				mode: "single",
				capturedAt: "",
				results: [{ status: "DONE", summary: "ok", evidence: "r", exitCode: 0 }],
			},
			calls: [],
		});

		const failed = emitted.find((e) => e.type === "phase_failed");
		expect(failed?.phase).toBe("review");
		// Precisely this: the finalizer reached the point of checking for
		// REVIEW.md on disk. That only works if it rebuilt (sLabel, wtPath)
		// from sliceId + DB — zero closure state.
		expect(failed?.error).toBe("missing REVIEW.md");

		rmSync(root, { recursive: true, force: true });
		db.close();
	});

	it("execute finalizer advances to the next open wave using only DB state", async () => {
		__resetFinalizersForTest();
		registerPhaseFinalizers();

		const db = openDatabase(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-stateless-exec-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Exec" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceTier(db, sliceId, "SS");
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");

		// 3 tasks in 2 waves. Wave 1 has 1 task (task A). Wave 2 has 2 tasks (B, C).
		const taskAId = insertTask(db, { sliceId, number: 1, title: "A", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "B", wave: 2 });
		insertTask(db, { sliceId, number: 3, title: "C", wave: 2 });

		const pi = {
			events: {
				emit: () => {},
				on: () => {},
			},
			sendUserMessage: () => {},
		};

		const finalizer = __getFinalizerForTest("execute");
		expect(finalizer).toBeDefined();
		if (!finalizer) return;

		// Simulate wave 1 returning DONE for task A.
		const outcome = await finalizer({
			pi: pi as never,
			db,
			root,
			settings: DEFAULT_SETTINGS,
			config: {
				mode: "parallel",
				phase: "execute",
				sliceId,
				tasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: taskAId }],
			},
			result: {
				mode: "parallel",
				capturedAt: "",
				results: [{ status: "DONE", summary: "", evidence: "ok", taskId: taskAId, exitCode: 0 }],
			},
			calls: [],
		});

		// Wave 1 finalized, wave 2 queued — this only works if the finalizer
		// recomputed the wave plan from DB (closure would have been empty).
		expect(outcome).toEqual({ continue: true });
		expect(getTask(db, taskAId)?.status).toBe("closed");
		// Wave 2 tasks still open, awaiting next dispatch.
		const stillOpen = getTasks(db, sliceId).filter((t) => t.status === "open");
		expect(stillOpen).toHaveLength(2);

		rmSync(root, { recursive: true, force: true });
		db.close();
	});
});
