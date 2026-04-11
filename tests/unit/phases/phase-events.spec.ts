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

vi.mock("../../../src/common/plannotator-review.js", () => ({
	requestReview: vi.fn().mockResolvedValue({ approved: true }),
	buildReviewRequest: vi.fn(),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	removeWorktree: vi.fn(),
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
	loadPhaseResources: vi.fn().mockReturnValue({ agentPrompt: "# Agent", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
	buildPhasePrompt: vi
		.fn()
		.mockReturnValue({ systemPrompt: "", userPrompt: "", tools: [], label: "" }),
	buildHeadlessDiscussPrompt: vi
		.fn()
		.mockReturnValue({ systemPrompt: "", userPrompt: "", tools: [], label: "" }),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: true, missing: [] }),
}));

import { requestReview } from "../../../src/common/plannotator-review.js";
import { discussPhase } from "../../../src/phases/discuss.js";
import { planPhase } from "../../../src/phases/plan.js";
import { researchPhase } from "../../../src/phases/research.js";

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

function setupDb(milestoneStatus?: string): {
	db: Database.Database;
	root: string;
	sliceId: string;
} {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-phase-events-"));
	initTffDirectory(root);
	insertProject(db, { name: "TFF", vision: "Vision" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, "SS");
	writeArtifact(root, "PROJECT.md", "# TFF");
	if (milestoneStatus) {
		updateSliceStatus(db, sliceId, milestoneStatus as Parameters<typeof updateSliceStatus>[2]);
	}
	return { db, root, sliceId };
}

describe("phase event emission", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		mockDispatch.mockResolvedValue({ success: true, output: "done" });
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	describe("discussPhase", () => {
		beforeEach(() => {
			({ db, root, sliceId } = setupDb());
		});

		it("emits phase_start on entry", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await discussPhase.run(ctx);

			const startCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "discuss",
			);
			expect(startCalls).toHaveLength(1);
		});

		it("does NOT emit phase_complete in interactive mode (tracked on /tff next)", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await discussPhase.run(ctx);

			expect(result.success).toBe(true);
			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "discuss",
			);
			expect(completeCalls).toHaveLength(0);
		});

		it("emits phase_failed when dispatch fails (headless)", async () => {
			mockDispatch.mockResolvedValueOnce({ success: false, output: "agent error" });
			const mockEmit = vi.fn();
			const ctx = { ...makeCtx(db, root, sliceId, mockEmit), headless: true };
			const result = await discussPhase.run(ctx);

			expect(result.success).toBe(false);
			const failedCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "discuss",
			);
			expect(failedCalls).toHaveLength(1);
			expect(failedCalls[0]?.[1]).toHaveProperty("error", "agent error");
			expect(failedCalls[0]?.[1]).toHaveProperty("durationMs");
		});

		it("phase_complete includes tier when slice has tier (headless)", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Req");
			const mockEmit = vi.fn();
			const ctx = { ...makeCtx(db, root, sliceId, mockEmit), headless: true };
			await discussPhase.run(ctx);

			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "discuss",
			);
			expect(completeCalls).toHaveLength(1);
			expect(completeCalls[0]?.[1]).toHaveProperty("tier", "SS");
		});

		it("emits phase_retried when gate is denied mid-loop (headless)", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Req");
			const mockRequestReview = vi.mocked(requestReview);
			// First attempt denied, second approved
			mockRequestReview
				.mockResolvedValueOnce({ approved: false, feedback: "Gate denied" })
				.mockResolvedValueOnce({ approved: true });

			const mockEmit = vi.fn();
			const ctx = { ...makeCtx(db, root, sliceId, mockEmit), headless: true };
			await discussPhase.run(ctx);

			const retriedCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_retried" && e.phase === "discuss",
			);
			expect(retriedCalls).toHaveLength(1);
			expect(retriedCalls[0]?.[1]).toHaveProperty("feedback", "Gate denied");
			expect(retriedCalls[0]?.[1]).toHaveProperty("durationMs");
		});
	});

	describe("researchPhase", () => {
		beforeEach(() => {
			({ db, root, sliceId } = setupDb("discussing"));
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		});

		it("emits phase_start on entry", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/RESEARCH.md", "# Research");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await researchPhase.run(ctx);

			const startCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "research",
			);
			expect(startCalls).toHaveLength(1);
		});

		it("emits phase_complete on success", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/RESEARCH.md", "# Research");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await researchPhase.run(ctx);

			expect(result.success).toBe(true);
			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "research",
			);
			expect(completeCalls).toHaveLength(1);
			expect(completeCalls[0]?.[1]).toHaveProperty("durationMs");
		});

		it("emits phase_failed when dispatch fails", async () => {
			mockDispatch.mockResolvedValueOnce({ success: false, output: "researcher error" });
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await researchPhase.run(ctx);

			expect(result.success).toBe(false);
			const failedCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "research",
			);
			expect(failedCalls).toHaveLength(1);
			expect(failedCalls[0]?.[1]).toHaveProperty("error", "researcher error");
		});
	});

	describe("planPhase", () => {
		beforeEach(() => {
			({ db, root, sliceId } = setupDb("researching"));
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			writeArtifact(root, "milestones/M01/slices/M01-S01/RESEARCH.md", "# Research");
		});

		it("emits phase_start on entry", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await planPhase.run(ctx);

			const startCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "plan",
			);
			expect(startCalls).toHaveLength(1);
		});

		it("emits phase_complete on success", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await planPhase.run(ctx);

			expect(result.success).toBe(true);
			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "plan",
			);
			expect(completeCalls).toHaveLength(1);
			expect(completeCalls[0]?.[1]).toHaveProperty("durationMs");
		});

		it("emits phase_failed when dispatch fails", async () => {
			mockDispatch.mockResolvedValueOnce({ success: false, output: "planner error" });
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await planPhase.run(ctx);

			expect(result.success).toBe(false);
			const failedCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "plan",
			);
			expect(failedCalls).toHaveLength(1);
			expect(failedCalls[0]?.[1]).toHaveProperty("error", "planner error");
		});

		it("emits phase_retried when gate is denied mid-loop", async () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
			const mockRequestReview = vi.mocked(requestReview);
			// First attempt denied, second approved
			mockRequestReview
				.mockResolvedValueOnce({ approved: false })
				.mockResolvedValueOnce({ approved: true });

			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await planPhase.run(ctx);

			const retriedCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_retried" && e.phase === "plan",
			);
			expect(retriedCalls).toHaveLength(1);
			expect(retriedCalls[0]?.[1]).toHaveProperty("feedback", "Gate denied, retrying");
			expect(retriedCalls[0]?.[1]).toHaveProperty("durationMs");
		});
	});

	describe("base event fields", () => {
		it("phase_start includes sliceId, sliceLabel, milestoneNumber, timestamp", async () => {
			({ db, root, sliceId } = setupDb());
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await discussPhase.run(ctx);

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
});
