import { mkdtempSync, rmSync } from "node:fs";
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
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
}));

vi.mock("../../../src/common/git.js", () => ({
	getDiff: vi.fn().mockReturnValue("diff content"),
	gitEnv: vi.fn().mockReturnValue({}),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
	getDefaultBranch: vi.fn().mockReturnValue("main"),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Reviewer", protocol: "# Protocol" }),
	loadAgentResource: vi.fn().mockReturnValue("# Security Review\nOWASP checks"),
}));

import { reviewPhase } from "../../../src/phases/review.js";

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

describe("reviewPhase event emission", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-review-events-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceStatus(db, sliceId, "verifying");
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
		writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verified");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("emits phase_start on entry", async () => {
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "review",
		);
		expect(startCalls).toHaveLength(1);
	});

	it("does NOT emit phase_complete (interactive mode, tracked on /tff next)", async () => {
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await reviewPhase.run(ctx);

		expect(result.success).toBe(true);
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "review",
		);
		expect(completeCalls).toHaveLength(0);
	});

	it("includes base event fields on phase_start", async () => {
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

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
