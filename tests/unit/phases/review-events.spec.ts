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

import { reviewPhase } from "../../../src/phases/review.js";

const APPROVED_VERDICT = JSON.stringify({ verdict: "approved", summary: "LGTM", findings: [] });
const DENIED_VERDICT = JSON.stringify({
	verdict: "denied",
	summary: "Bad code",
	findings: [{ file: "src/foo.ts", message: "Issue" }],
	tasksToRework: ["T01"],
});

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

describe("reviewPhase event emission", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		mockDispatch.mockReset();
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
		mockDispatch.mockResolvedValue({ success: true, output: APPROVED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "review",
		);
		expect(startCalls).toHaveLength(1);
	});

	it("emits phase_complete when both reviewers approve", async () => {
		mockDispatch.mockResolvedValue({ success: true, output: APPROVED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await reviewPhase.run(ctx);

		expect(result.success).toBe(true);
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "review",
		);
		expect(completeCalls).toHaveLength(1);
		expect(completeCalls[0]?.[1]).toHaveProperty("durationMs");
	});

	it("emits phase_failed when review is denied", async () => {
		mockDispatch
			.mockResolvedValueOnce({ success: true, output: DENIED_VERDICT })
			.mockResolvedValueOnce({ success: true, output: APPROVED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		const result = await reviewPhase.run(ctx);

		expect(result.success).toBe(false);
		const failedCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "review",
		);
		expect(failedCalls).toHaveLength(1);
		expect(failedCalls[0]?.[1]).toHaveProperty("durationMs");
	});

	it("emits review_verdict for both code and security reviewers on approval", async () => {
		mockDispatch.mockResolvedValue({ success: true, output: APPROVED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

		const verdictCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:review" && e.type === "review_verdict",
		);
		expect(verdictCalls).toHaveLength(2);

		const reviewers = verdictCalls.map(([, e]) => e.reviewer);
		expect(reviewers).toContain("code");
		expect(reviewers).toContain("security");
	});

	it("emits review_verdict with correct verdict and findingCount", async () => {
		mockDispatch
			.mockResolvedValueOnce({ success: true, output: DENIED_VERDICT })
			.mockResolvedValueOnce({ success: true, output: APPROVED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

		const verdictCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:review" && e.type === "review_verdict",
		);
		expect(verdictCalls).toHaveLength(2);

		const codeVerdict = verdictCalls.find(([, e]) => e.reviewer === "code")?.[1];
		expect(codeVerdict).toBeDefined();
		expect(codeVerdict).toHaveProperty("verdict", "denied");
		expect(codeVerdict).toHaveProperty("findingCount", 1);
		expect(codeVerdict).toHaveProperty("summary", "Bad code");
		expect(codeVerdict).toHaveProperty("tasksToRework");

		const securityVerdict = verdictCalls.find(([, e]) => e.reviewer === "security")?.[1];
		expect(securityVerdict).toBeDefined();
		expect(securityVerdict).toHaveProperty("verdict", "approved");
		expect(securityVerdict).toHaveProperty("findingCount", 0);
	});

	it("emits review_verdict even when both deny", async () => {
		mockDispatch.mockResolvedValue({ success: true, output: DENIED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

		const verdictCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:review" && e.type === "review_verdict",
		);
		expect(verdictCalls).toHaveLength(2);
	});

	it("includes base event fields on review_verdict events", async () => {
		mockDispatch.mockResolvedValue({ success: true, output: APPROVED_VERDICT });
		const mockEmit = vi.fn();
		const ctx = makeCtx(db, root, sliceId, mockEmit);
		await reviewPhase.run(ctx);

		const verdictCall = mockEmit.mock.calls.find(
			([ch, e]) => ch === "tff:review" && e.type === "review_verdict",
		);
		expect(verdictCall).toBeDefined();
		const event = verdictCall?.[1];
		expect(event).toHaveProperty("sliceId");
		expect(event).toHaveProperty("sliceLabel", "M01-S01");
		expect(event).toHaveProperty("milestoneNumber", 1);
		expect(event).toHaveProperty("timestamp");
	});
});
