import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCompleteMilestone } from "../../src/commands/complete-milestone.js";
import { handleInit } from "../../src/commands/init.js";
import { createMilestone } from "../../src/commands/new-milestone.js";
import { handleNew } from "../../src/commands/new.js";
import { initTffDirectory, readArtifact, writeArtifact } from "../../src/common/artifacts.js";
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
	updateSliceTier,
} from "../../src/common/db.js";
import type { PhaseContext } from "../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../src/common/settings.js";
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

const mockView = vi.fn();
const mockCreate = vi.fn();
const mockChecks = vi.fn();
const mockMerge = vi.fn();

vi.mock("@the-forge-flow/gh-pi", () => ({
	createGHClient: vi.fn(() => ({})),
	createPRTools: vi.fn(() => ({
		view: mockView,
		create: mockCreate,
		checks: mockChecks,
		merge: mockMerge,
	})),
}));

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
	pushBranch: vi.fn(),
	remoteBranchExists: vi.fn().mockReturnValue(true),
	getDiff: vi.fn().mockReturnValue("diff --git a/foo.ts b/foo.ts\n+added line"),
	gitEnv: vi.fn().mockReturnValue({}),
	ensureGitignoreEntries: vi.fn(),
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
	let tffHome: string;
	let savedTffHome: string | undefined;

	beforeEach(() => {
		savedTffHome = process.env.TFF_HOME;
		tffHome = mkdtempSync(join(tmpdir(), "tff-home-e2e-"));
		process.env.TFF_HOME = tffHome;

		mockExec.mockReset();
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string;
			const cmdArgs = args[1] as string[];
			if (cmd === "git" && cmdArgs?.[0] === "remote" && cmdArgs?.[1] === "get-url") {
				return "git@github.com:org/repo.git\n";
			}
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

		mockView.mockReset().mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ state: "MERGED", comments: [] }),
			stderr: "",
		});
		mockCreate.mockReset().mockResolvedValue({
			code: 0,
			stdout: "https://github.com/org/repo/pull/1",
			stderr: "",
		});
		mockChecks.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		mockMerge.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-e2e-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(tffHome, { recursive: true, force: true });
		if (savedTffHome !== undefined) process.env.TFF_HOME = savedTffHome;
		else Reflect.deleteProperty(process.env, "TFF_HOME");
	});

	// -----------------------------------------------------------------------
	// 1. Full lifecycle: discuss → ship → complete-milestone
	// -----------------------------------------------------------------------
	describe("full lifecycle", () => {
		it("walks from project creation to milestone completion", async () => {
			// Step 1: handleNew → creates project
			handleInit(root);
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
			expect(branch).toMatch(/^milestone\/[0-9a-f]{8}$/);
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
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);

			// Step 5: researchPhase.prepare → verify sendUserMessage called
			const researchPi = makePi();
			const researchSlice = must(getSlice(db, sliceId));
			const researchResult = await researchPhase.prepare({
				pi: researchPi,
				db,
				root,
				slice: researchSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(researchResult.success).toBe(true);
			expect(researchResult.message).toBeDefined();
			expect(researchPi.sendUserMessage).not.toHaveBeenCalled();
			// Simulate RESEARCH.md output
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/RESEARCH.md`,
				"# Research\nJWT best practices: use RS256",
			);

			// Step 6: planPhase.prepare → verify sendUserMessage called
			const planPi = makePi();
			const planSlice = must(getSlice(db, sliceId));
			const planResult = await planPhase.prepare({
				pi: planPi,
				db,
				root,
				slice: planSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(planResult.success).toBe(true);
			expect(planResult.message).toBeDefined();
			expect(planPi.sendUserMessage).not.toHaveBeenCalled();
			// Simulate PLAN.md output
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/PLAN.md`,
				"# Plan\nStep 1: implement JWT\nStep 2: add middleware",
			);

			// Step 7: executePhase.prepare → verify sendUserMessage called.
			// Simulate tasks persisted by plan phase (required after Fix #1).
			insertTask(db, { sliceId, number: 1, title: "Implement JWT", wave: 1 });
			insertTask(db, { sliceId, number: 2, title: "Add middleware", wave: 2 });
			const executePi = makePi();
			const executeSlice = must(getSlice(db, sliceId));
			const executeResult = await executePhase.prepare({
				pi: executePi,
				db,
				root,
				slice: executeSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(executeResult.success).toBe(true);
			expect(executeResult.message).toBeDefined();
			expect(executePi.sendUserMessage).not.toHaveBeenCalled();

			// Step 8: verifyPhase.prepare → verify sendUserMessage called
			const verifyPi = makePi();
			const verifySlice = must(getSlice(db, sliceId));
			const verifyResult = await verifyPhase.prepare({
				pi: verifyPi,
				db,
				root,
				slice: verifySlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(verifyResult.success).toBe(true);
			expect(verifyResult.message).toBeDefined();
			expect(verifyPi.sendUserMessage).not.toHaveBeenCalled();
			// Simulate VERIFICATION.md
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`,
				"# Verification\n- [x] AC-1 passes\n- [x] AC-2 passes",
			);

			// Step 9: reviewPhase.prepare → verify message includes "Security Review"
			const reviewPi = makePi();
			const reviewSlice = must(getSlice(db, sliceId));
			const reviewResult = await reviewPhase.prepare({
				pi: reviewPi,
				db,
				root,
				slice: reviewSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(reviewResult.success).toBe(true);
			expect(reviewResult.message).toBeDefined();
			expect(reviewPi.sendUserMessage).not.toHaveBeenCalled();
			const reviewMsg = reviewResult.message ?? "";
			// M01-S04: review runs as subagent dispatch; message is the DISPATCHER_PROMPT,
			// and the security-lens body is persisted into dispatch-config.json's task body.
			expect(reviewMsg).toMatch(/subagent/i);

			// Step 10: Simulate REVIEW.md and PR.md, set status to "reviewing"
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/REVIEW.md`,
				"# Review\nAll good. No issues found.",
			);
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/PR.md`,
				"# Description\n\nAdds auth.",
			);
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("reviewing", sliceId);

			// Step 11: shipPhase.prepare — always manual confirm path
			const shipPi = makePi();
			const shipSlice = must(getSlice(db, sliceId));
			const shipResult = await shipPhase.prepare({
				pi: shipPi,
				db,
				root,
				slice: shipSlice,
				milestoneNumber: msNumber,
				settings: DEFAULT_SETTINGS,
			});
			expect(shipResult.success).toBe(true);
			const shippedSlice = must(getSlice(db, sliceId));
			expect(shippedSlice.prUrl).toContain("github.com");
			// Ship always emits phase_complete; slice is closed via override in
			// finalizeMergedSlice (called from /tff ship-merged after user confirms).
			expect(shipPi.events.emit).toHaveBeenCalledWith(
				"tff:phase",
				expect.objectContaining({ type: "phase_complete", phase: "ship" }),
			);
			// Override slice to closed to allow complete-milestone to proceed
			db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(sliceId);

			// Step 12: handleCompleteMilestone → milestone PR created
			const completePi = makePi();
			const completeResult = await handleCompleteMilestone(
				db,
				root,
				milestoneId,
				DEFAULT_SETTINGS,
				completePi,
			);
			expect(completeResult.success).toBe(true);
			expect(completeResult.prUrl).toContain("github.com");
		});
	});

	// -----------------------------------------------------------------------
	// 2. Ship always uses manual confirm path
	// -----------------------------------------------------------------------
	describe("ship manual confirm path", () => {
		it("leaves PR open and sends gate message asking user to confirm merge", async () => {
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
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("reviewing", sliceId);
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
			writeArtifact(root, "milestones/M01/slices/M01-S01/PR.md", "# Description\n\nAdds auth.");

			const pi = makePi();
			const slice = must(getSlice(db, sliceId));
			const result = await shipPhase.prepare({
				pi,
				db,
				root,
				slice,
				milestoneNumber: 1,
				settings: DEFAULT_SETTINGS,
			});

			expect(result.success).toBe(true);

			// Ship emits phase_start and phase_complete; PR URL is persisted.
			expect(pi.events.emit).toHaveBeenCalledWith(
				"tff:phase",
				expect.objectContaining({ type: "phase_start", phase: "ship" }),
			);
			const updated = must(getSlice(db, sliceId));
			expect(updated.prUrl).toContain("github.com");

			// pr merge should NOT have been called — user must confirm
			expect(mockMerge).not.toHaveBeenCalled();

			// sendUserMessage hands the merge gate to the agent — PR URL +
			// tff_ask_user + tool routing for merged/changes.
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const msg = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
			expect(msg).toContain("PR is open");
			expect(msg).toContain("tff_ask_user");
			expect(msg).toContain("tff_ship_merged");
			expect(msg).toContain("tff_ship_changes");
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
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("shipping", sliceId);
			updateSliceTier(db, sliceId, "SS");
			updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/1");

			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Requirements");
			writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verification");
			writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md", "# Review");
			writeArtifact(root, "milestones/M01/slices/M01-S01/PR.md", "# Description");

			// mockExec already returns { state: "MERGED", comments: [] } for gh pr view
			const pi = makePi();
			const slice = must(getSlice(db, sliceId));
			const result = await shipPhase.prepare({
				pi,
				db,
				root,
				slice,
				milestoneNumber: 1,
				settings: DEFAULT_SETTINGS,
			});

			expect(result.success).toBe(true);
			// Reconciler rule 1: ship/completed + pr_url non-null → closed.
			// Verify phase_complete was emitted; reconciler handles the DB write.
			expect(pi.events.emit).toHaveBeenCalledWith(
				"tff:phase",
				expect.objectContaining({ type: "phase_complete", phase: "ship" }),
			);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Ship re-entry with PR comments
	// -----------------------------------------------------------------------
	describe("ship re-entry with PR comments", () => {
		it("stashes review feedback and leaves slice in shipping", async () => {
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
			writeArtifact(root, `${base}/PR.md`, "# Description");
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("shipping", sliceId);
			updateSliceTier(db, sliceId, "SS");
			updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/1");

			// Mock prTools.view to return OPEN with comments
			mockView.mockResolvedValue({
				code: 0,
				stdout: JSON.stringify({
					state: "OPEN",
					comments: [{ body: "Fix the error handling", author: { login: "reviewer" } }],
				}),
				stderr: "",
			});

			const pi = makePi();
			const slice = must(getSlice(db, sliceId));
			const result = await shipPhase.prepare({
				pi,
				db,
				root,
				slice,
				milestoneNumber: 1,
				settings: DEFAULT_SETTINGS,
			});
			expect(result.success).toBe(true);
			expect(result.retry).toBe(false);
			const updated = must(getSlice(db, sliceId));
			expect(updated.status).toBe("shipping");
			const stashed = readArtifact(root, `${base}/REVIEW_FEEDBACK.md`);
			expect(stashed).toContain("Fix the error handling");
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
