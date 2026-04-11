import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, readArtifact, writeArtifact } from "../../../src/common/artifacts.js";
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
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Verifier", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
	buildPhasePrompt: vi
		.fn()
		.mockReturnValue({ systemPrompt: "", userPrompt: "", tools: [], label: "" }),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: true, missing: [] }),
	enrichContextWithFff: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/common/fff-integration.js", () => ({
	discoverFffService: vi.fn().mockReturnValue(null),
	FffBridge: vi.fn(),
}));

import { verifyPhase } from "../../../src/phases/verify.js";

describe("verifyPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		mockDispatch.mockResolvedValue({
			success: true,
			output: JSON.stringify({
				acResults: [{ ac: "AC-1", status: "PASS", explanation: "OK" }],
				testResults: { passed: 5, failed: 0, skipped: 0, output: "All pass" },
			}),
		});
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-verify-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceStatus(db, sliceId, "executing");
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1: auth works");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof verifyPhase.run).toBe("function");
	});

	it("succeeds when AC verification and tests pass", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await verifyPhase.run(ctx);
		expect(result.success).toBe(true);
	});

	it("writes VERIFICATION.md artifact", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await verifyPhase.run(ctx);
		const verification = readArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md");
		expect(verification).not.toBeNull();
		expect(verification).toContain("AC-1");
	});

	it("fails and requests retry when agent reports failure", async () => {
		mockDispatch.mockResolvedValue({ success: false, output: "AC-2 failed" });
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await verifyPhase.run(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
	});
});
