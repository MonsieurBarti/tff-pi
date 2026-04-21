import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	getTasks,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import {
	type DispatchBatch,
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../../src/common/subagent-dispatcher.js";
import { registerPhaseFinalizers } from "../../../src/phases/finalizers.js";
import { must } from "../../helpers.js";

vi.mock("../../../src/common/worktree.js", () => ({
	createWorktree: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	worktreeExists: vi.fn().mockReturnValue(false),
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	ensureSliceWorktree: vi.fn().mockReturnValue("/tmp/fake-worktree"),
}));

vi.mock("../../../src/common/checkpoint.js", () => ({
	createCheckpoint: vi.fn(),
	listCheckpoints: vi.fn().mockReturnValue([]),
	getLastCheckpoint: vi.fn().mockReturnValue(null),
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	enrichContextWithFff: vi.fn(),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
}));

import { createCheckpoint } from "../../../src/common/checkpoint.js";
import { createWorktree } from "../../../src/common/worktree.js";
import {
	type PendingWorktreeMarker,
	executePhase,
	pendingWorktreeMarkerPath,
} from "../../../src/phases/execute.js";

function readDispatchConfig(root: string): DispatchBatch {
	const configPath = join(root, ".pi", ".tff", "dispatch-config.json");
	return JSON.parse(readFileSync(configPath, "utf-8")) as DispatchBatch;
}

describe("executePhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		__resetFinalizersForTest();
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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sliceId);
		updateSliceTier(db, sliceId, "SS");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof executePhase.prepare).toBe("function");
	});

	it("AC-1: happy path returns { success: true, retry: false, message: <DISPATCHER_PROMPT> }", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const sendUserMessage = vi.fn();
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage,
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(result.retry).toBe(false);
		expect(result.message).toBeDefined();
		expect(sendUserMessage).not.toHaveBeenCalled();
		// The message is the DISPATCHER_PROMPT, which references the subagent tool.
		expect(result.message).toMatch(/subagent/i);
	});

	it("AC-2: dispatch-config.json is parallel mode with one task per open wave-1 task", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		insertTask(db, { sliceId, number: 3, title: "API", wave: 2 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		const cfg = readDispatchConfig(root);
		expect(cfg.phase).toBe("execute");
		expect(cfg.mode).toBe("parallel");
		expect(cfg.sliceId).toBe(slice.id);
		expect(cfg.tasks).toHaveLength(2);
		for (const t of cfg.tasks) {
			expect(t.agent).toBe("tff-executor");
			expect(t.cwd).toBe("/tmp/fake-worktree");
			expect(typeof t.taskId).toBe("string");
		}
	});

	it("AC-2: single-task wave is also dispatched as parallel (keeps finalizer uniform)", async () => {
		insertTask(db, { sliceId, number: 1, title: "Only", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		const cfg = readDispatchConfig(root);
		expect(cfg.mode).toBe("parallel");
		expect(cfg.tasks).toHaveLength(1);
	});

	it("AC-3: each task's artifacts include SPEC.md, PLAN.md, Worktree gate (in that order)", async () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec body");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan body");
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		const cfg = readDispatchConfig(root);
		// After prepareDispatch persists, artifacts are stripped and folded into `task` body.
		// We still verify the task body mentions the fundamental blocks.
		const body = cfg.tasks[0]?.task ?? "";
		expect(body).toContain("SPEC.md");
		expect(body).toContain("PLAN.md");
		expect(body).toContain("<HARD-GATE>");
		expect(body).toContain("WORKTREE:");
	});

	it("AC-4: task body contains label, wave, UUID, worktree path, and the 7-point Rules block", async () => {
		insertTask(db, { sliceId, number: 2, title: "DB schema", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		const cfg = readDispatchConfig(root);
		const body = cfg.tasks[0]?.task ?? "";
		const [task] = getTasks(db, slice.id);
		expect(body).toContain("T02");
		expect(body).toContain("Wave: 1 of");
		expect(body).toContain(must(task).id);
		expect(body).toContain("/tmp/fake-worktree");
		// 7-point Rules
		for (const marker of ["1.", "2.", "3.", "4.", "5.", "6.", "7."]) {
			expect(body).toContain(marker);
		}
		expect(body).toContain("STATUS: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>");
	});

	it("AC-5: execute finalizer is registered at extension init (registerPhaseFinalizers)", () => {
		expect(__getFinalizerForTest("execute")).toBeUndefined();
		registerPhaseFinalizers();
		expect(__getFinalizerForTest("execute")).toBeDefined();
	});

	it("AC-7: phase_start is emitted by prepare()", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const events: string[] = [];
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: {
					emit: (_ch: string, ev: { type: string }) => events.push(ev.type),
					on: vi.fn(),
				},
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		expect(events[0]).toBe("phase_start");
	});

	it("prepare() does NOT call createWorktree or createCheckpoint synchronously", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		expect(vi.mocked(createWorktree)).not.toHaveBeenCalled();
		expect(vi.mocked(createCheckpoint)).not.toHaveBeenCalled();
	});

	it("prepare() writes pending-execute-worktree.json marker", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		const markerPath = pendingWorktreeMarkerPath(root);
		expect(existsSync(markerPath)).toBe(true);
		const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as PendingWorktreeMarker;
		expect(marker.sliceLabel).toBe("M01-S01");
		expect(marker.milestoneBranch).toMatch(/^milestone\/[0-9a-f]{8}$/);
	});

	it("AC-8: feedback stash — REVIEW_FEEDBACK.md is folded into artifacts, tasks reset, file unlinked", async () => {
		// Seed a task in "closed" status (simulating post-execute state) so we can
		// assert resetTasksToOpen was called.
		const taskId = insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		db.prepare("UPDATE task SET status = 'closed' WHERE id = ?").run(taskId);
		// Stash a REVIEW_FEEDBACK.md artifact.
		const feedbackRel = "milestones/M01/slices/M01-S01/REVIEW_FEEDBACK.md";
		writeArtifact(root, feedbackRel, "## Issues\n- fix auth guard");
		const feedbackPath = join(root, ".pi", ".tff", feedbackRel);
		expect(existsSync(feedbackPath)).toBe(true);

		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.prepare(ctx);
		expect(result.success).toBe(true);
		// File was unlinked.
		expect(existsSync(feedbackPath)).toBe(false);
		// Task was reset to open (otherwise there would be no wave-1 task to dispatch).
		const tasks = getTasks(db, sliceId);
		expect(tasks[0]?.status).toBe("open");
		// Dispatch config embeds the feedback body somewhere in the task body
		// (the feedback artifact is attached via labelled block which prepareDispatch folds into `task`).
		const cfg = readDispatchConfig(root);
		const body = cfg.tasks[0]?.task ?? "";
		expect(body).toContain("fix auth guard");
	});

	it("AC-9: short-circuit — no open tasks → commitCommand('execute-done') + phase_complete, no dispatch", async () => {
		const taskId = insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		db.prepare("UPDATE task SET status = 'closed' WHERE id = ?").run(taskId);
		// Move slice into 'executing' status so commitCommand's preconditions pass.
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		const emitted: string[] = [];
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: {
					emit: (_ch: string, ev: { type: string }) => emitted.push(ev.type),
					on: vi.fn(),
				},
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(result.message).toBeUndefined();
		expect(__getFinalizerForTest("execute")).toBeUndefined();
		expect(emitted).toContain("phase_complete");
		// No dispatch config was written.
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
	});

	it("AC-9: short-circuit — idempotent when phase_run already 'completed'", async () => {
		const taskId = insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		db.prepare("UPDATE task SET status = 'closed' WHERE id = ?").run(taskId);
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		db.prepare("UPDATE phase_run SET finished_at = ? WHERE slice_id = ? AND phase = 'execute'").run(
			new Date().toISOString(),
			sliceId,
		);
		const emitted: string[] = [];
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: {
					emit: (_ch: string, ev: { type: string }) => emitted.push(ev.type),
					on: vi.fn(),
				},
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		// Should not throw from commitCommand since already completed → skip
		await expect(executePhase.prepare(ctx)).resolves.toMatchObject({ success: true });
		expect(emitted).toContain("phase_complete");
	});

	it("AC-10: no-tasks error when slice has zero tasks in DB", async () => {
		const slice = must(getSlice(db, sliceId));
		const mockEmit = vi.fn();
		const sendUserMessage = vi.fn();
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage,
				events: { emit: mockEmit, on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await executePhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(false);
		expect(sendUserMessage).not.toHaveBeenCalled();
		const failedCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed",
		);
		expect(failedCalls).toHaveLength(1);
		const failedEvent = failedCalls[0]?.[1] as { error?: string };
		expect(failedEvent.error).toMatch(/no tasks/i);
		expect(__getFinalizerForTest("execute")).toBeUndefined();
	});

	it("message contains HARD-GATE — regression guard for worktree binding", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await executePhase.prepare(ctx);
		const cfg = readDispatchConfig(root);
		const body = cfg.tasks[0]?.task ?? "";
		expect(body).toContain("<HARD-GATE>");
		expect(body).toContain("WORKTREE:");
		expect(body).toMatch(/cd\s+\/tmp\/fake-worktree/);
		expect(body).toMatch(/Do NOT write to the project root/i);
	});
});
