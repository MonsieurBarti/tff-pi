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

const mockDispatch = vi.fn();
vi.mock("../../../src/common/dispatch.js", () => ({
	dispatchSubAgent: (...args: unknown[]) => mockDispatch(...args),
	buildSubagentTask: vi.fn().mockReturnValue("task"),
}));

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
	enrichContextWithFff: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/common/fff-integration.js", () => ({
	discoverFffService: vi.fn().mockReturnValue(null),
	FffBridge: vi.fn(),
}));

import { reviewPhase } from "../../../src/phases/review.js";

describe("reviewPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		mockDispatch.mockReset();
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-review-test-"));
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

	it("succeeds when both reviewers approve", async () => {
		mockDispatch.mockResolvedValue({
			success: true,
			output: JSON.stringify({ verdict: "approved", summary: "LGTM", findings: [] }),
		});
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await reviewPhase.run(ctx);
		expect(result.success).toBe(true);
	});

	it("fails with retry when code reviewer denies", async () => {
		mockDispatch
			.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					verdict: "denied",
					summary: "Bad code",
					findings: [],
					tasksToRework: ["T01"],
				}),
			})
			.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({ verdict: "approved", summary: "OK", findings: [] }),
			});
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await reviewPhase.run(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		expect(result.feedback).toContain("Bad code");
	});

	it("dispatches two reviewers in parallel", async () => {
		mockDispatch.mockResolvedValue({
			success: true,
			output: JSON.stringify({ verdict: "approved", summary: "OK", findings: [] }),
		});
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await reviewPhase.run(ctx);
		expect(mockDispatch).toHaveBeenCalledTimes(2);
	});
});
