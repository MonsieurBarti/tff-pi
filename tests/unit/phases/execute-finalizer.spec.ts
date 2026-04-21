import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import {
	type DispatchBatch,
	type DispatchResult,
	type FinalizeInput,
	type FinalizeOutcome,
	type Finalizer,
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../../src/common/subagent-dispatcher.js";
import { registerPhaseFinalizers } from "../../../src/phases/finalizers.js";
import { must } from "../../helpers.js";

let worktreePath = "";

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn(() => worktreePath),
	createWorktree: vi.fn(() => worktreePath),
	worktreeExists: vi.fn().mockReturnValue(true),
	ensureSliceWorktree: vi.fn(() => worktreePath),
}));

const createCheckpointMock = vi.fn();
vi.mock("../../../src/common/checkpoint.js", () => ({
	createCheckpoint: (cwd: string, sliceLabel: string, name: string) => {
		createCheckpointMock(cwd, sliceLabel, name);
	},
	listCheckpoints: vi.fn().mockReturnValue([]),
	getLastCheckpoint: vi.fn().mockReturnValue(null),
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	enrichContextWithFff: vi.fn(),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
}));

import { executePhase } from "../../../src/phases/execute.js";

interface TestCtx {
	db: Database.Database;
	root: string;
	worktreePath: string;
	sliceId: string;
	slice: ReturnType<typeof getSlice>;
	pi: PhaseContext["pi"];
	emitted: Array<{ type: string; [k: string]: unknown }>;
	taskIds: string[];
}

function doneResult(taskIds: string[]): DispatchResult {
	return {
		mode: "parallel",
		capturedAt: "",
		results: taskIds.map((taskId) => ({
			status: "DONE",
			summary: "ok",
			evidence: "done",
			taskId,
			exitCode: 0,
		})),
	};
}

function mixedResult(
	entries: Array<{
		taskId: string;
		status: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
		evidence?: string;
	}>,
): DispatchResult {
	return {
		mode: "parallel",
		capturedAt: "",
		results: entries.map((e) => ({
			status: e.status,
			summary: "",
			evidence: e.evidence ?? "ev",
			taskId: e.taskId,
			exitCode: e.status === "BLOCKED" || e.status === "NEEDS_CONTEXT" ? 1 : 0,
		})),
	};
}

function readDispatchConfig(root: string): DispatchBatch {
	return JSON.parse(
		readFileSync(join(root, ".pi", ".tff", "dispatch-config.json"), "utf-8"),
	) as DispatchBatch;
}

function getFinalizer(): Finalizer {
	const f = __getFinalizerForTest("execute");
	if (!f) throw new Error("execute finalizer not registered");
	return f;
}

function invokeFinalizer(
	t: TestCtx,
	input: {
		result: DispatchResult;
		calls: FinalizeInput["calls"];
		configTasks?: FinalizeInput["config"]["tasks"];
	},
	// biome-ignore lint/suspicious/noConfusingVoidType: matches Finalizer return type in production
): Promise<FinalizeOutcome | void> {
	return getFinalizer()({
		pi: t.pi as unknown as FinalizeInput["pi"],
		db: t.db,
		root: t.root,
		settings: DEFAULT_SETTINGS,
		config: {
			mode: "parallel",
			phase: "execute",
			sliceId: t.sliceId,
			tasks: input.configTasks ?? [],
		},
		result: input.result,
		calls: input.calls,
	});
}

async function seedCtx(config: {
	waves: Array<Array<{ n: number; title: string }>>;
	sliceStatus?: string;
}): Promise<TestCtx> {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-exec-fin-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-exec-fin-wt-"));
	initTffDirectory(root);

	insertProject(db, { name: "TFF", vision: "V" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Exec" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, "SS");
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(
		config.sliceStatus ?? "executing",
		sliceId,
	);
	insertPhaseRun(db, {
		sliceId,
		phase: "execute",
		status: "started",
		startedAt: new Date().toISOString(),
	});
	writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
	writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");

	const taskIds: string[] = [];
	let waveNum = 1;
	for (const wave of config.waves) {
		for (const t of wave) {
			const tid = insertTask(db, { sliceId, number: t.n, title: t.title, wave: waveNum });
			taskIds.push(tid);
		}
		waveNum += 1;
	}

	const emitted: Array<{ type: string; [k: string]: unknown }> = [];
	const pi = {
		sendUserMessage: vi.fn(),
		events: {
			emit: (ch: string, ev: unknown) => {
				if (ch === "tff:phase") emitted.push(ev as { type: string; [k: string]: unknown });
			},
			on: vi.fn(),
		},
	} as unknown as PhaseContext["pi"];

	return {
		db,
		root,
		worktreePath,
		sliceId,
		slice: getSlice(db, sliceId),
		pi,
		emitted,
		taskIds,
	};
}

function phaseCtx(t: TestCtx): PhaseContext {
	return {
		pi: t.pi,
		db: t.db,
		root: t.root,
		slice: must(t.slice),
		milestoneNumber: 1,
		settings: DEFAULT_SETTINGS,
	};
}

describe("execute finalizer", () => {
	let t: TestCtx;

	beforeEach(async () => {
		__resetFinalizersForTest();
		registerPhaseFinalizers();
		createCheckpointMock.mockClear();
	});

	afterEach(() => {
		if (t) {
			rmSync(t.root, { recursive: true, force: true });
			rmSync(t.worktreePath, { recursive: true, force: true });
			t.db.close();
		}
	});

	it("AC-18 / AC-21: final wave, all DONE → closes tasks, checkpoint, commitCommand, phase_complete, continue:false", async () => {
		t = await seedCtx({ waves: [[{ n: 1, title: "Types" }]] });
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;

		const outcome = await invokeFinalizer(t, {
			result: doneResult([must(t.taskIds[0])]),
			calls: [],
			configTasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) }],
		});

		const task = getTask(t.db, must(t.taskIds[0]));
		expect(task?.status).toBe("closed");
		expect(createCheckpointMock).toHaveBeenCalledWith(t.worktreePath, "M01-S01", "wave-1");
		expect(t.emitted.some((e) => e.type === "phase_complete" && e.phase === "execute")).toBe(true);
		expect(outcome).toEqual({ continue: false });
	});

	it("AC-18: DONE_WITH_CONCERNS also closes the task", async () => {
		t = await seedCtx({ waves: [[{ n: 1, title: "Types" }]] });
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;

		await invokeFinalizer(t, {
			result: mixedResult([{ taskId: must(t.taskIds[0]), status: "DONE_WITH_CONCERNS" }]),
			calls: [],
			configTasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) }],
		});
		const task = getTask(t.db, must(t.taskIds[0]));
		expect(task?.status).toBe("closed");
	});

	it("AC-19 / AC-20: happy mid-wave → checkpoint uses DB wave number, prepareDispatch writes next wave, continue:true", async () => {
		t = await seedCtx({
			waves: [[{ n: 1, title: "A" }], [{ n: 2, title: "B" }]],
		});
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;

		const outcome = await invokeFinalizer(t, {
			result: doneResult([must(t.taskIds[0])]),
			calls: [],
			configTasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) }],
		});

		expect(createCheckpointMock).toHaveBeenCalledWith(t.worktreePath, "M01-S01", "wave-1");
		// Wave 1 task closed, wave 2 task still open
		expect(getTask(t.db, must(t.taskIds[0]))?.status).toBe("closed");
		expect(getTask(t.db, must(t.taskIds[1]))?.status).toBe("open");
		// Next-wave dispatch config is persisted.
		const cfg = readDispatchConfig(t.root);
		expect(cfg.tasks).toHaveLength(1);
		expect(cfg.tasks[0]?.taskId).toBe(t.taskIds[1]);
		expect(outcome).toEqual({ continue: true });
		// phase_complete NOT yet emitted (not final wave).
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
	});

	it("AC-22: BLOCKED anywhere → partial checkpoint, phase_failed, no next-wave dispatch, continue:false; DONE siblings still closed", async () => {
		t = await seedCtx({
			waves: [
				[
					{ n: 1, title: "A" },
					{ n: 2, title: "B" },
				],
				[{ n: 3, title: "C" }],
			],
		});
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;

		const outcome = await invokeFinalizer(t, {
			result: mixedResult([
				{ taskId: must(t.taskIds[0]), status: "DONE" },
				{ taskId: must(t.taskIds[1]), status: "BLOCKED", evidence: "kaboom" },
			]),
			calls: [],
			configTasks: [
				{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) },
				{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[1]) },
			],
		});

		expect(createCheckpointMock).toHaveBeenCalledWith(t.worktreePath, "M01-S01", "wave-1-partial");
		// T01 (DONE) closed, T02 (BLOCKED) still open, T03 (wave 2) still open
		expect(getTask(t.db, must(t.taskIds[0]))?.status).toBe("closed");
		expect(getTask(t.db, must(t.taskIds[1]))?.status).toBe("open");
		expect(getTask(t.db, must(t.taskIds[2]))?.status).toBe("open");
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(String(failed?.error)).toMatch(/^BLOCKED:/);
		expect(String(failed?.error)).toContain("kaboom");
		expect(outcome).toEqual({ continue: false });
		// phase_complete NOT emitted.
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
	});

	it("AC-23: final-wave idempotency — phase_run already 'completed' → skip commitCommand, re-emit phase_complete", async () => {
		t = await seedCtx({ waves: [[{ n: 1, title: "Only" }]] });
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;

		// Simulate crash-recovery: mark phase_run as completed before re-invoking finalizer.
		t.db
			.prepare(
				"UPDATE phase_run SET status = 'completed', finished_at = ? WHERE slice_id = ? AND phase = 'execute'",
			)
			.run(new Date().toISOString(), t.sliceId);

		const outcome = await invokeFinalizer(t, {
			result: doneResult([must(t.taskIds[0])]),
			calls: [],
			configTasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) }],
		});

		// Task closure re-applied (idempotent no-op since already closed).
		expect(getTask(t.db, must(t.taskIds[0]))?.status).toBe("closed");
		// phase_complete re-emitted even though phase_run was already completed.
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(true);
		expect(outcome).toEqual({ continue: false });
	});

	it("AC-24: finalizer does not swallow internal errors — a throw from createCheckpoint propagates", async () => {
		t = await seedCtx({ waves: [[{ n: 1, title: "Only" }]] });
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;
		createCheckpointMock.mockImplementationOnce(() => {
			throw new Error("fs-error");
		});

		await expect(
			invokeFinalizer(t, {
				result: doneResult([must(t.taskIds[0])]),
				calls: [],
				configTasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) }],
			}),
		).rejects.toThrow("fs-error");
	});

	it("AC-18: results without a taskId are skipped for closure (non-final wave)", async () => {
		// Use a 2-wave setup so the finalizer takes the continue:true branch and
		// does NOT call commitCommand (which would fail the precondition since
		// the task stays open).
		t = await seedCtx({
			waves: [[{ n: 1, title: "A" }], [{ n: 2, title: "B" }]],
		});
		await executePhase.prepare(phaseCtx(t));
		t.emitted.length = 0;

		const outcome = await invokeFinalizer(t, {
			result: {
				mode: "parallel",
				capturedAt: "",
				results: [{ status: "DONE", summary: "", evidence: "a", exitCode: 0 /* no taskId */ }],
			},
			calls: [],
			configTasks: [{ agent: "tff-executor", task: "", cwd: "", taskId: must(t.taskIds[0]) }],
		});
		// Task remains open — no taskId → no closure.
		const tasks = getTasks(t.db, t.sliceId);
		expect(tasks.find((x) => x.number === 1)?.status).toBe("open");
		expect(outcome).toEqual({ continue: true });
	});
});
