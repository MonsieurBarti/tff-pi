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
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
}));

import { reviewPhase } from "../../../src/phases/review.js";

describe("reviewPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("verifying", sliceId);
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
		writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verified");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns success and sends message", async () => {
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
		const result = await reviewPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(result.message).toBeDefined();
	});

	it("message includes spec, plan, verification, and diff", async () => {
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
		const result = await reviewPhase.prepare(ctx);
		const msg = result.message ?? "";
		expect(msg).toContain("SPEC.md");
		expect(msg).toContain("PLAN.md");
		expect(msg).toContain("VERIFICATION.md");
		// Diff is no longer inlined — agent runs `git diff` itself
		expect(msg).not.toContain("diff content");
		expect(msg).toMatch(/git .* diff .*milestone\/[0-9a-f]{8}\.\.\.slice\/[0-9a-f]{8}/);
	});

	it("message includes security reviewer content", async () => {
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
		const result = await reviewPhase.prepare(ctx);
		const msg = result.message ?? "";
		expect(msg).toContain("Security Review");
		expect(msg).toContain("OWASP checks");
	});

	it("emits phase_start event", async () => {
		const mockEmit = vi.fn();
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
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
		await reviewPhase.prepare(ctx);
		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "review",
		);
		expect(startCalls).toHaveLength(1);
	});
});
