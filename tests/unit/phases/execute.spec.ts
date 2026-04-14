import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

// execute.prepare() no longer calls createWorktree/createCheckpoint directly —
// those are deferred to session_start via the marker file. We still mock the
// module so any accidental call is caught, and to provide getWorktreePath.
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
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Executor", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sliceId);
		updateSliceTier(db, sliceId, "SS");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof executePhase.prepare).toBe("function");
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
		const result = await executePhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(result.message).toBeDefined();
		expect(result.message).toContain("Wave 1");
		expect(result.message).toContain("Wave 2");
	});

	it("message contains a HARD-GATE block binding the agent to the worktree path", async () => {
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
		expect(sendUserMessage).not.toHaveBeenCalled();
		const msg = result.message ?? "";
		// The worktree gate is a critical invariant — regressing it causes
		// agents to write to the project root and the verify phase sees an
		// empty diff. Guard it structurally.
		expect(msg).toContain("<HARD-GATE>");
		expect(msg).toContain("WORKTREE:");
		expect(msg).toContain("/tmp/fake-worktree"); // the mocked createWorktree path
		expect(msg).toMatch(/cd\s+\/tmp\/fake-worktree/);
		expect(msg).toMatch(/Do NOT write to the project root/i);
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
		expect(marker.milestoneBranch).toBe("milestone/M01");
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
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete",
		);
		expect(completeCalls).toHaveLength(0);
	});
});
