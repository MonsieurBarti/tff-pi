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

vi.mock("../../../src/common/worktree.js", () => ({
	createWorktree: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	worktreeExists: vi.fn().mockReturnValue(false),
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
}));

vi.mock("../../../src/common/checkpoint.js", () => ({
	createCheckpoint: vi.fn(),
	listCheckpoints: vi.fn().mockReturnValue([]),
	getLastCheckpoint: vi.fn().mockReturnValue(null),
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Executor", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
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
		pi: {
			sendUserMessage: vi.fn(),
			events: { emit: mockEmit, on: vi.fn() },
		} as unknown as PhaseContext["pi"],
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
		await executePhase.prepare(ctx);

		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "execute",
		);
		expect(startCalls).toHaveLength(1);
	});

	it("emits phase_failed when no tasks exist", async () => {
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await executePhase.prepare(ctx);

		expect(result.success).toBe(false);
		const failedCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "execute",
		);
		expect(failedCalls).toHaveLength(1);
		expect(failedCalls[0]?.[1]).toHaveProperty("error");
	});

	it("does NOT emit phase_complete when tasks exist (interactive)", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await executePhase.prepare(ctx);

		expect(result.success).toBe(true);
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "execute",
		);
		expect(completeCalls).toHaveLength(0);
	});

	it("includes base event fields on phase events", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await executePhase.prepare(ctx);

		const startCall = mockEmit.mock.calls.find(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start",
		);
		expect(startCall).toBeDefined();
		const event = startCall?.[1];
		expect(event).toHaveProperty("sliceId");
		expect(event).toHaveProperty("sliceLabel", "M01-S01");
		expect(event).toHaveProperty("milestoneNumber", 1);
		expect(event).toHaveProperty("timestamp");
	});
});
