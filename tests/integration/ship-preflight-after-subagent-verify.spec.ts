import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, writeArtifact } from "../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceTier,
} from "../../src/common/db.js";
import type { PhaseContext } from "../../src/common/phase.js";
import { validateCommandPreconditions } from "../../src/common/preconditions.js";
import { DEFAULT_SETTINGS } from "../../src/common/settings.js";
import {
	type DispatchResult,
	type Finalizer,
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../src/common/subagent-dispatcher.js";
import { must } from "../helpers.js";

// Per-slice worktree path, captured by the mocked getWorktreePath helper.
let worktreePath = "";

vi.mock("../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn(() => worktreePath),
}));

vi.mock("../../src/common/git.js", () => ({
	getDiff: vi.fn().mockReturnValue("diff content"),
	gitEnv: vi.fn().mockReturnValue({}),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
	getDefaultBranch: vi.fn().mockReturnValue("main"),
	getTrackedDirtyEntries: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/common/checkpoint.js", () => ({
	createCheckpoint: vi.fn(),
}));

vi.mock("../../src/common/verify-commands.js", () => ({
	detectVerifyCommands: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/common/mechanical-verifier.js", () => ({
	runMechanicalVerification: vi.fn(),
	formatMechanicalReport: vi.fn().mockReturnValue(""),
}));

vi.mock("../../src/common/compress.js", () => ({
	compressIfEnabled: vi.fn((input: string) => input),
}));

vi.mock("../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Verifier", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
}));

import { verifyPhase } from "../../src/phases/verify.js";

interface TestCtx {
	db: Database.Database;
	root: string;
	worktreePath: string;
	sliceId: string;
	pi: PhaseContext["pi"];
}

const SLICE_DIR = "milestones/M01/slices/M01-S01";

function seedCtx(): TestCtx {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-ship-pre-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-ship-pre-wt-"));
	initTffDirectory(root);
	mkdirSync(join(worktreePath, ".pi", ".tff", "artifacts"), { recursive: true });

	insertProject(db, { name: "TFF", vision: "V" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, "SS");
	db.prepare("UPDATE slice SET status = 'verifying' WHERE id = ?").run(sliceId);
	insertPhaseRun(db, {
		sliceId,
		phase: "verify",
		status: "started",
		startedAt: new Date().toISOString(),
	});
	writeArtifact(root, `${SLICE_DIR}/SPEC.md`, "# Spec\nAC-1: auth works");
	writeArtifact(root, `${SLICE_DIR}/PLAN.md`, "# Plan");

	const pi = {
		sendUserMessage: vi.fn(),
		events: {
			emit: vi.fn(),
			on: vi.fn(),
		},
	} as unknown as PhaseContext["pi"];

	return { db, root, worktreePath, sliceId, pi };
}

function makePhaseCtx(t: TestCtx): PhaseContext {
	return {
		pi: t.pi,
		db: t.db,
		root: t.root,
		slice: must(getSlice(t.db, t.sliceId)),
		milestoneNumber: 1,
		settings: DEFAULT_SETTINGS,
	};
}

function doneResult(): DispatchResult {
	return {
		mode: "single",
		capturedAt: "",
		results: [
			{
				status: "DONE",
				summary: "ok",
				evidence: "all green",
				exitCode: 0,
			},
		],
	};
}

function writeWorktreeArtifact(t: TestCtx, name: string, content: string): void {
	writeFileSync(join(t.worktreePath, ".pi", ".tff", "artifacts", name), content, "utf-8");
}

function getFinalizer(): Finalizer {
	const f = __getFinalizerForTest("verify");
	if (!f) throw new Error("verify finalizer not registered");
	return f;
}

/**
 * Drive the verify phase finalizer through its happy-path branch end-to-end:
 * register the closure via prepare(), pre-write VERIFICATION.md + PR.md into
 * the worktree artifacts dir, then invoke the finalizer directly with a
 * synthesized DONE result + empty captured calls (so audit has nothing to
 * flag — keep VERIFICATION.md free of bash-run claims).
 *
 * Post-condition: write-pr event appended, phase_run.verify flipped to
 * completed. Slice status is still 'verifying' (the finalizer does not
 * advance slice state — that happens during /tff ship).
 */
async function runHappyVerifyEndToEnd(t: TestCtx): Promise<void> {
	await verifyPhase.prepare(makePhaseCtx(t));
	writeWorktreeArtifact(t, "VERIFICATION.md", "# Verification\n\n- [x] AC-1\n- [x] AC-2\n");
	writeWorktreeArtifact(t, "PR.md", "## Summary\nSubagent verify wired.\n");
	await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
}

/**
 * After the verify finalizer has appended the write-pr event, the slice
 * advances to 'shipping' (normally via /tff ship). Simulate that transition
 * so the ship-changes precondition's slice-status check passes. This lets
 * the test isolate the guard we actually care about: that the write-pr
 * event survives the subagent-verify flow and satisfies the ship precondition.
 */
function advanceToShipping(t: TestCtx): void {
	t.db.prepare("UPDATE slice SET status = 'shipping' WHERE id = ?").run(t.sliceId);
	insertPhaseRun(t.db, {
		sliceId: t.sliceId,
		phase: "ship",
		status: "started",
		startedAt: new Date().toISOString(),
	});
}

describe("ship-changes precondition after subagent verify (AC-35 regression guard)", () => {
	let t: TestCtx;

	beforeEach(() => {
		__resetFinalizersForTest();
		t = seedCtx();
	});

	afterEach(() => {
		rmSync(t.root, { recursive: true, force: true });
		rmSync(t.worktreePath, { recursive: true, force: true });
		t.db.close();
	});

	it("AC-35: ship-changes precondition passes after happy subagent verify", async () => {
		await runHappyVerifyEndToEnd(t);
		advanceToShipping(t);

		const result = validateCommandPreconditions(t.db, t.root, "ship-changes", {
			sliceId: t.sliceId,
		});

		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("AC-35 negative control: ship-changes precondition fails when verify has not run", () => {
		// Slice remains in 'verifying' — seedCtx set it there and no finalizer ran.
		const result = validateCommandPreconditions(t.db, t.root, "ship-changes", {
			sliceId: t.sliceId,
		});

		expect(result.ok).toBe(false);
		// Slice-status guard fires first (the slice is not yet shipping).
		expect(result.reason).toContain("shipping");
	});
});
