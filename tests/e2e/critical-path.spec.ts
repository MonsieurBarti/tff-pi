import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCompleteMilestone } from "../../src/commands/complete-milestone.js";
import { createMilestone } from "../../src/commands/new-milestone.js";
import { handleNew } from "../../src/commands/new.js";
import { initTffDirectory, writeArtifact } from "../../src/common/artifacts.js";
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
	updateSlicePrUrl,
	updateSliceStatus,
	updateSliceTier,
} from "../../src/common/db.js";
import type { PhaseContext } from "../../src/common/phase.js";
import { DEFAULT_SETTINGS, type Settings } from "../../src/common/settings.js";
import { milestoneLabel, sliceLabel } from "../../src/common/types.js";
import { handleCreateSlice } from "../../src/tools/create-slice.js";
import { must } from "../helpers.js";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing phases
// ---------------------------------------------------------------------------

const mockExec = vi.fn().mockReturnValue("");
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		execFileSync: (...args: unknown[]) => mockExec(...args),
	};
});

vi.mock("../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	removeWorktree: vi.fn(),
	createWorktree: vi.fn().mockReturnValue("/tmp/fake-worktree"),
}));

vi.mock("../../src/common/git.js", () => ({
	getDefaultBranch: vi.fn().mockReturnValue("main"),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
	getDiff: vi.fn().mockReturnValue("diff --git a/foo.ts b/foo.ts\n+added line"),
	gitEnv: vi.fn().mockReturnValue({}),
}));

vi.mock("../../src/orchestrator.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/orchestrator.js")>();
	return {
		...original,
		loadPhaseResources: vi.fn().mockReturnValue({ agentPrompt: "# Agent", protocol: "# Protocol" }),
		loadAgentResource: vi.fn().mockReturnValue("# Security Review\nOWASP checks"),
	};
});

// ---------------------------------------------------------------------------
// Imports that depend on mocks
// ---------------------------------------------------------------------------

import { executePhase } from "../../src/phases/execute.js";
import { planPhase } from "../../src/phases/plan.js";
import { researchPhase } from "../../src/phases/research.js";
import { reviewPhase } from "../../src/phases/review.js";
import { preflightCheck, shipPhase } from "../../src/phases/ship.js";
import { verifyPhase } from "../../src/phases/verify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Partial<Settings> = {}): Settings {
	return {
		...DEFAULT_SETTINGS,
		compress: { ...DEFAULT_SETTINGS.compress },
		ship: { ...DEFAULT_SETTINGS.ship },
		...overrides,
	};
}

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as PhaseContext["pi"];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E critical path", () => {
	let db: Database.Database;
	let root: string;

	beforeEach(() => {
		mockExec.mockReset();
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string;
			const cmdArgs = args[1] as string[];
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "create") {
				return "https://github.com/org/repo/pull/1\n";
			}
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "checks") {
				return "All checks passed\n";
			}
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "view") {
				return JSON.stringify({ state: "MERGED", comments: [] });
			}
			return "";
		});

		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-e2e-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// 1. Full lifecycle: discuss → ship → complete-milestone
	// -----------------------------------------------------------------------
	describe("full lifecycle", () => {
		it("walks from project creation to milestone completion", async () => {
			// Step 1: handleNew → creates project
			const { projectId } = handleNew(db, root, {
				projectName: "TestApp",
				vision: "Build a test application",
			});
			const project = must(getProject(db));
			expect(project.name).toBe("TestApp");
			expect(project.id).toBe(projectId);

			// Step 2: createMilestone → creates milestone with branch
			const {
				milestoneId,
				number: msNumber,
				branch,
			} = createMilestone(db, root, projectId, "Foundation");
			expect(msNumber).toBe(1);
			expect(branch).toBe("milestone/M01");
			const milestones = getMilestones(db, projectId);
			expect(milestones).toHaveLength(1);

			// Step 3: handleCreateSlice → creates slice, status "created"
			const sliceResult = handleCreateSlice(db, root, milestoneId, "Auth module");
			expect(sliceResult.isError).toBeFalsy();
			const sliceId = (sliceResult.details as { sliceId: string }).sliceId;
			const sliceAfterCreate = must(getSlice(db, sliceId));
			expect(sliceAfterCreate.status).toBe("created");

			// Step 4: Simulate discuss outputs
			const mLabel = milestoneLabel(msNumber);
			const sLabel = sliceLabel(msNumber, sliceAfterCreate.number);
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/SPEC.md`,
				"# Spec\nAC-1: auth works\nAC-2: tokens expire",
			);
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/REQUIREMENTS.md`,
				"# Requirements\nR1: JWT auth\nR2: session management",
			);
			updateSliceTier(db, sliceId, "SS");
			updateSliceStatus(db, sliceId, "discussing");

			// Step 5: researchPhase.run → verify sendUserMessage called
			const researchPi = makePi();
			const researchSlice = must(getSlice(db, sliceId));
			const researchResult = await researchPhase.run({
				pi: researchPi,
				db,
				root,
				slice: researchSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(researchResult.success).toBe(true);
			expect(researchPi.sendUserMessage).toHaveBeenCalledTimes(1);
			// Simulate RESEARCH.md output
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/RESEARCH.md`,
				"# Research\nJWT best practices: use RS256",
			);

			// Step 6: planPhase.run → verify sendUserMessage called
			const planPi = makePi();
			const planSlice = must(getSlice(db, sliceId));
			const planResult = await planPhase.run({
				pi: planPi,
				db,
				root,
				slice: planSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(planResult.success).toBe(true);
			expect(planPi.sendUserMessage).toHaveBeenCalledTimes(1);
			// Simulate PLAN.md output
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/PLAN.md`,
				"# Plan\nStep 1: implement JWT\nStep 2: add middleware",
			);

			// Step 7: executePhase.run → verify sendUserMessage called.
			// Simulate tasks persisted by plan phase (required after Fix #1).
			insertTask(db, { sliceId, number: 1, title: "Implement JWT", wave: 1 });
			insertTask(db, { sliceId, number: 2, title: "Add middleware", wave: 2 });
			const executePi = makePi();
			const executeSlice = must(getSlice(db, sliceId));
			const executeResult = await executePhase.run({
				pi: executePi,
				db,
				root,
				slice: executeSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(executeResult.success).toBe(true);
			expect(executePi.sendUserMessage).toHaveBeenCalledTimes(1);

			// Step 8: verifyPhase.run → verify sendUserMessage called
			const verifyPi = makePi();
			const verifySlice = must(getSlice(db, sliceId));
			const verifyResult = await verifyPhase.run({
				pi: verifyPi,
				db,
				root,
				slice: verifySlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(verifyResult.success).toBe(true);
			expect(verifyPi.sendUserMessage).toHaveBeenCalledTimes(1);
			// Simulate VERIFICATION.md
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`,
				"# Verification\n- [x] AC-1 passes\n- [x] AC-2 passes",
			);

			// Step 9: reviewPhase.run → verify message includes "Security Review"
			const reviewPi = makePi();
			const reviewSlice = must(getSlice(db, sliceId));
			const reviewResult = await reviewPhase.run({
				pi: reviewPi,
				db,
				root,
				slice: reviewSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(reviewResult.success).toBe(true);
			expect(reviewPi.sendUserMessage).toHaveBeenCalledTimes(1);
			const reviewMsg = (reviewPi.sendUserMessage as ReturnType<typeof vi.fn>).mock
				.calls[0]?.[0] as string;
			expect(reviewMsg).toContain("Security Review");

			// Step 10: Simulate REVIEW.md, set status to "reviewing"
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/REVIEW.md`,
				"# Review\nAll good. No issues found.",
			);
			updateSliceStatus(db, sliceId, "reviewing");

			// Step 11: shipPhase.run with auto_merge: true
			const shipPi = makePi();
			const shipSlice = must(getSlice(db, sliceId));
			const shipResult = await shipPhase.run({
				pi: shipPi,
				db,
				root,
				slice: shipSlice,
				milestoneNumber: msNumber,
				settings: makeSettings({ ship: { auto_merge: true } }),
			});
			expect(shipResult.success).toBe(true);
			const shippedSlice = must(getSlice(db, sliceId));
			expect(shippedSlice.prUrl).toContain("github.com");
			expect(shippedSlice.status).toBe("closed");

			// Step 12: handleCompleteMilestone → milestone PR created
			const completeResult = handleCompleteMilestone(db, root, milestoneId, DEFAULT_SETTINGS);
			expect(completeResult.success).toBe(true);
			expect(completeResult.prUrl).toContain("github.com");
		});
	});

	// -----------------------------------------------------------------------
	// 2. Ship with auto_merge disabled
	// -----------------------------------------------------------------------
	describe("ship with auto_merge disabled", () => {
		it("leaves PR open and tells user it is ready for review", async () => {
			// Set up project, milestone, slice with all artifacts
			initTffDirectory(root);
			insertProject(db, { name: "TFF", vision: "Vision" });
			const projectId = must(getProject(db)).id;
			insertMilestone(db, {
				projectId,
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const milestoneId = must(getMilestones(db, projectId)[0]).id;
			insertSlice(db, { milestoneId, number: 1, title: "Auth" });
			const sliceId = must(getSlices(db, milestoneId)[0]).id;
			updateSliceStatus(db, sliceId, "reviewing");
			updateSliceTier(db, sliceId, "SS");

			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1: auth works");
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan\nStep 1: implement");
			writeArtifact(
				root,
				"milestones/M01/slices/M01-S01/REQUIREMENTS.md",
				"# Requirements\nR1: auth",
			);
			writeArtifact(
				root,
				"milestones/M01/slices/M01-S01/VERIFICATION.md",
				"# Verification\n- [x] All pass",
			);
			writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md", "# Review\nAll good");

			const pi = makePi();
			const slice = must(getSlice(db, sliceId));
			const result = await shipPhase.run({
				pi,
				db,
				root,
				slice,
				milestoneNumber: 1,
				settings: makeSettings({ ship: { auto_merge: false } }),
			});

			expect(result.success).toBe(true);

			// Slice should be "shipping" (not closed)
			const updated = must(getSlice(db, sliceId));
			expect(updated.status).toBe("shipping");
			expect(updated.prUrl).toContain("github.com");

			// gh pr merge should NOT have been called
			const mergeCalls = mockExec.mock.calls.filter(
				(call: unknown[]) =>
					call[0] === "gh" &&
					(call[1] as string[])?.[0] === "pr" &&
					(call[1] as string[])?.[1] === "merge",
			);
			expect(mergeCalls).toHaveLength(0);

			// sendUserMessage should mention "ready for review"
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const msg = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
			expect(msg).toContain("ready for review");
		});
	});

	// -----------------------------------------------------------------------
	// 3. Ship re-entry — merged PR
	// -----------------------------------------------------------------------
	describe("ship re-entry with merged PR", () => {
		it("closes the slice when PR is already merged", async () => {
			// Set up slice at "shipping" with prUrl already set
			initTffDirectory(root);
			insertProject(db, { name: "TFF", vision: "Vision" });
			const projectId = must(getProject(db)).id;
			insertMilestone(db, {
				projectId,
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const milestoneId = must(getMilestones(db, projectId)[0]).id;
			insertSlice(db, { milestoneId, number: 1, title: "Auth" });
			const sliceId = must(getSlices(db, milestoneId)[0]).id;
			updateSliceStatus(db, sliceId, "shipping");
			updateSliceTier(db, sliceId, "SS");
			updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/1");

			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Requirements");
			writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verification");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md", "# Review");

			// mockExec already returns { state: "MERGED", comments: [] } for gh pr view
			const pi = makePi();
			const slice = must(getSlice(db, sliceId));
			const result = await shipPhase.run({
				pi,
				db,
				root,
				slice,
				milestoneNumber: 1,
				settings: DEFAULT_SETTINGS,
			});

			expect(result.success).toBe(true);
			const updated = must(getSlice(db, sliceId));
			expect(updated.status).toBe("closed");
		});
	});

	// -----------------------------------------------------------------------
	// 4. Ship re-entry with PR comments
	// -----------------------------------------------------------------------
	describe("ship re-entry with PR comments", () => {
		it("transitions back to executing with feedback", async () => {
			initTffDirectory(root);
			insertProject(db, { name: "TFF", vision: "Vision" });
			const projectId = must(getProject(db)).id;
			insertMilestone(db, {
				projectId,
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const milestoneId = must(getMilestones(db, projectId)[0]).id;
			insertSlice(db, { milestoneId, number: 1, title: "Auth" });
			const sliceId = must(getSlices(db, milestoneId)[0]).id;

			const mLabel = milestoneLabel(1);
			const sLabel = sliceLabel(1, 1);
			const base = `milestones/${mLabel}/slices/${sLabel}`;

			writeArtifact(root, `${base}/SPEC.md`, "# Spec");
			writeArtifact(root, `${base}/REQUIREMENTS.md`, "# Req");
			writeArtifact(root, `${base}/PLAN.md`, "# Plan");
			writeArtifact(root, `${base}/VERIFICATION.md`, "# V\n- [x] pass");
			writeArtifact(root, `${base}/REVIEW.md`, "# Review");
			updateSliceStatus(db, sliceId, "shipping");
			updateSliceTier(db, sliceId, "SS");
			updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/1");

			// Mock gh pr view to return OPEN with comments
			mockExec.mockImplementation((...args: unknown[]) => {
				const cmd = args[0] as string;
				const cmdArgs = args[1] as string[];
				if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "view") {
					return JSON.stringify({
						state: "OPEN",
						comments: [{ body: "Fix the error handling", author: { login: "reviewer" } }],
					});
				}
				return "";
			});

			const pi = makePi();
			const slice = must(getSlice(db, sliceId));
			const result = await shipPhase.run({
				pi,
				db,
				root,
				slice,
				milestoneNumber: 1,
				settings: DEFAULT_SETTINGS,
			});
			expect(result.success).toBe(false);
			expect(result.retry).toBe(true);
			expect(result.feedback).toContain("Fix the error handling");
			const updated = must(getSlice(db, sliceId));
			expect(updated.status).toBe("executing");
		});
	});

	// -----------------------------------------------------------------------
	// 5. Pre-flight rejects missing verification
	// -----------------------------------------------------------------------
	describe("preflight rejects missing verification", () => {
		it("returns errors when VERIFICATION.md is absent", () => {
			initTffDirectory(root);
			insertProject(db, { name: "TFF", vision: "Vision" });
			const projectId = must(getProject(db)).id;
			insertMilestone(db, {
				projectId,
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const milestoneId = must(getMilestones(db, projectId)[0]).id;
			insertSlice(db, { milestoneId, number: 1, title: "Auth" });
			const sliceId = must(getSlices(db, milestoneId)[0]).id;
			updateSliceTier(db, sliceId, "SS");

			// Write all artifacts EXCEPT VERIFICATION.md
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1: works");
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan\nStep 1");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Requirements");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md", "# Review\nAll good");

			const slice = must(getSlice(db, sliceId));
			const result = preflightCheck(root, slice, 1);

			expect(result.ok).toBe(false);
			expect(result.errors).toContain("VERIFICATION.md missing");
		});
	});
});
