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

const mockDispatch = vi.fn();
vi.mock("../../../src/common/dispatch.js", () => ({
	dispatchSubAgent: (...args: unknown[]) => mockDispatch(...args),
	buildSubagentTask: vi.fn().mockReturnValue("task"),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	createWorktree: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	worktreeExists: vi.fn().mockReturnValue(false),
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Executor", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
	buildPhasePrompt: vi
		.fn()
		.mockReturnValue({ systemPrompt: "", userPrompt: "", tools: [], label: "" }),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: true, missing: [] }),
}));

import { executePhase } from "../../../src/phases/execute.js";

function makeCtx(
	db: Database.Database,
	root: string,
	sliceId: string,
	mockEmit: ReturnType<typeof vi.fn>,
): PhaseContext {
	const slice = must(getSlice(db, sliceId));
	return {
		pi: { events: { emit: mockEmit, on: vi.fn() } } as unknown as PhaseContext["pi"],
		db,
		root,
		slice,
		milestoneNumber: 1,
		settings: DEFAULT_SETTINGS,
	};
}

describe("executePhase event emission", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		mockDispatch.mockResolvedValue({ success: true, output: "done" });
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-exec-events-test-"));
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

	it("emits phase_start at the beginning", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "execute",
		);
		expect(startCalls).toHaveLength(1);
	});

	it("emits phase_complete on success", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await executePhase.run(ctx);

		expect(result.success).toBe(true);
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "execute",
		);
		expect(completeCalls).toHaveLength(1);
		expect(completeCalls[0]?.[1]).toHaveProperty("durationMs");
	});

	it("emits phase_failed when all retries exhausted", async () => {
		insertTask(db, { sliceId, number: 1, title: "Broken", wave: 1 });
		mockDispatch.mockResolvedValue({ success: false, output: "executor error" });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await executePhase.run(ctx);

		expect(result.success).toBe(false);
		const failedCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "execute",
		);
		expect(failedCalls).toHaveLength(1);
		expect(failedCalls[0]?.[1]).toHaveProperty("durationMs");
	});

	it("emits wave_started for each wave with correct metadata", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		insertTask(db, { sliceId, number: 3, title: "API", wave: 2 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const waveStarted = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:wave" && e.type === "wave_started",
		);
		expect(waveStarted).toHaveLength(2);
		const wave1 = waveStarted.find(([, e]) => e.wave === 1)?.[1];
		expect(wave1).toBeDefined();
		expect(wave1).toHaveProperty("taskCount", 2);
		expect(wave1).toHaveProperty("totalWaves", 2);
		const wave2 = waveStarted.find(([, e]) => e.wave === 2)?.[1];
		expect(wave2).toBeDefined();
		expect(wave2).toHaveProperty("taskCount", 1);
	});

	it("emits wave_completed with durationMs after each wave", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const waveCompleted = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:wave" && e.type === "wave_completed",
		);
		expect(waveCompleted).toHaveLength(1);
		expect(waveCompleted[0]?.[1]).toHaveProperty("wave", 1);
		expect(waveCompleted[0]?.[1]).toHaveProperty("durationMs");
	});

	it("emits task_dispatched before each task", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const dispatched = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:task" && e.type === "task_dispatched",
		);
		expect(dispatched).toHaveLength(2);
		expect(dispatched[0]?.[1]).toHaveProperty("wave", 1);
		expect(dispatched[0]?.[1]).toHaveProperty("taskTitle");
	});

	it("emits task_completed for successful tasks", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const completed = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:task" && e.type === "task_completed",
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]?.[1]).toHaveProperty("wave", 1);
	});

	it("emits task_failed then task_retried for failing tasks", async () => {
		insertTask(db, { sliceId, number: 1, title: "Broken", wave: 1 });
		mockDispatch.mockResolvedValue({ success: false, output: "error" });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const failed = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:task" && e.type === "task_failed",
		);
		expect(failed.length).toBeGreaterThanOrEqual(1);

		const retried = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:task" && e.type === "task_retried",
		);
		// MAX_TASK_RETRIES = 2, so 2 retry events
		expect(retried).toHaveLength(2);
		expect(retried[0]?.[1]).toHaveProperty("attempt");
	});

	it("includes base event fields on wave events", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.run(ctx);

		const waveStarted = mockEmit.mock.calls.find(
			([ch, e]) => ch === "tff:wave" && e.type === "wave_started",
		);
		expect(waveStarted).toBeDefined();
		const event = waveStarted?.[1];
		expect(event).toHaveProperty("sliceId");
		expect(event).toHaveProperty("sliceLabel", "M01-S01");
		expect(event).toHaveProperty("milestoneNumber", 1);
		expect(event).toHaveProperty("timestamp");
	});
});
