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

describe("executePhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
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

	it("sends message with task list via sendUserMessage", async () => {
		insertTask(db, { sliceId, number: 1, title: "Types", wave: 1 });
		insertTask(db, { sliceId, number: 2, title: "DB", wave: 1 });
		insertTask(db, { sliceId, number: 3, title: "API", wave: 2 });

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
		const result = await executePhase.run(ctx);
		expect(result.success).toBe(true);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const msg = sendUserMessage.mock.calls[0]?.[0] as string;
		expect(msg).toContain("Wave 1");
		expect(msg).toContain("Wave 2");
	});

	it("fails with phase_failed when no tasks exist in DB", async () => {
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
		const result = await executePhase.run(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(false);
		expect(sendUserMessage).not.toHaveBeenCalled();
		const failedCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed",
		);
		expect(failedCalls).toHaveLength(1);
		const failedEvent = failedCalls[0]?.[1] as { error?: string };
		expect(failedEvent.error).toMatch(/no tasks/i);
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete",
		);
		expect(completeCalls).toHaveLength(0);
	});
});
