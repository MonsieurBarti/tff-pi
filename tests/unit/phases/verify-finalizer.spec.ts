import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactExists, initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
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
} from "../../../src/common/db.js";
import { readEvents } from "../../../src/common/event-log.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import {
	type CapturedCall,
	type DispatchResult,
	type Finalizer,
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../../src/common/subagent-dispatcher.js";
import { must } from "../../helpers.js";

// Per-slice worktree path: separate from project root so the finalizer's
// artifact-source (wtPath/.pi/.tff/artifacts/) and its artifact-destination
// (root/.pi/.tff/milestones/.../slices/...) don't collide.
let worktreePath = "";

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn(() => worktreePath),
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

vi.mock("../../../src/common/checkpoint.js", () => ({
	createCheckpoint: vi.fn(),
}));

vi.mock("../../../src/common/verify-commands.js", () => ({
	detectVerifyCommands: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/common/mechanical-verifier.js", () => ({
	runMechanicalVerification: vi.fn(),
	formatMechanicalReport: vi.fn().mockReturnValue(""),
}));

vi.mock("../../../src/common/compress.js", () => ({
	compressIfEnabled: vi.fn((input: string) => input),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Verifier", protocol: "# Protocol" }),
	determineNextPhase: vi.fn(),
	findActiveSlice: vi.fn(),
	collectPhaseContext: vi.fn().mockReturnValue({}),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
}));

import { verifyPhase } from "../../../src/phases/verify.js";

interface TestCtx {
	db: Database.Database;
	root: string;
	worktreePath: string;
	sliceId: string;
	slice: ReturnType<typeof getSlice>;
	pi: PhaseContext["pi"];
	emitted: Array<{ type: string; [k: string]: unknown }>;
}

const SLICE_DIR = "milestones/M01/slices/M01-S01";
const V_REL = `${SLICE_DIR}/VERIFICATION.md`;
const PR_REL = `${SLICE_DIR}/PR.md`;
const AUDIT_REL = `${SLICE_DIR}/VERIFICATION-AUDIT.md`;
const BLOCKED_REL = `${SLICE_DIR}/.audit-blocked`;

function seedCtx(): TestCtx {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-verify-fin-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-verify-fin-wt-"));
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

	const emitted: Array<{ type: string; [k: string]: unknown }> = [];
	const pi = {
		sendUserMessage: vi.fn(),
		events: {
			emit: (ch: string, ev: unknown) => {
				if (ch === "tff:phase") emitted.push(ev as { type: string; [k: string]: unknown });
			},
			on: vi.fn(),
		},
	} as unknown as PhaseContext["pi"];

	return {
		db,
		root,
		worktreePath,
		sliceId,
		slice: getSlice(db, sliceId),
		pi,
		emitted,
	};
}

function makePhaseCtx(t: TestCtx): PhaseContext {
	return {
		pi: t.pi,
		db: t.db,
		root: t.root,
		slice: must(t.slice),
		milestoneNumber: 1,
		settings: DEFAULT_SETTINGS,
	};
}

function blockedResult(evidence: string): DispatchResult {
	return {
		mode: "single",
		capturedAt: "",
		results: [
			{
				status: "BLOCKED",
				summary: "",
				evidence,
				exitCode: 0,
			},
		],
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

describe("verify finalizer", () => {
	let t: TestCtx;

	beforeEach(async () => {
		__resetFinalizersForTest();
		t = seedCtx();
		await verifyPhase.prepare(makePhaseCtx(t));
		// prepare() emits phase_start; clear before each branch's assertion
		t.emitted.length = 0;
	});

	afterEach(() => {
		rmSync(t.root, { recursive: true, force: true });
		rmSync(t.worktreePath, { recursive: true, force: true });
		t.db.close();
	});

	it("AC-17: BLOCKED result → resetTasksToOpen + phase_failed; no commit; no phase_complete", async () => {
		await getFinalizer()({
			root: t.root,
			result: blockedResult("agent gave up"),
			calls: [],
		});
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(failed?.phase).toBe("verify");
		expect(failed?.error).toBe("agent gave up");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		// phase_run remains in 'started' (no commit happened)
		const run = t.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(t.sliceId, "verify") as { status: string } | undefined;
		expect(run?.status).toBe("started");
		// No events logged
		expect(readEvents(t.root)).toHaveLength(0);
	});

	it("AC-18a: missing VERIFICATION.md → phase_failed naming the file; no commit", async () => {
		writeWorktreeArtifact(t, "PR.md", "pr content");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("VERIFICATION.md");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
	});

	it("AC-18b: missing PR.md → phase_failed naming the file", async () => {
		writeWorktreeArtifact(t, "VERIFICATION.md", "# V\nRan `bun test` — all pass.");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("PR.md");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
	});

	it("AC-19: audit mismatch → copy VERIFICATION.md + VERIFICATION-AUDIT.md + .audit-blocked + phase_failed; no commit; PR.md NOT copied", async () => {
		writeWorktreeArtifact(t, "VERIFICATION.md", "Ran `bun test` — all pass.");
		writeWorktreeArtifact(t, "PR.md", "pr content");
		const calls: CapturedCall[] = [
			{
				toolName: "bash",
				toolCallId: "c1",
				input: { command: "bun test" },
				isError: true,
				outputText: "FAIL",
				timestamp: 1,
			},
		];
		await getFinalizer()({ root: t.root, result: doneResult(), calls });
		expect(artifactExists(t.root, V_REL)).toBe(true);
		expect(artifactExists(t.root, AUDIT_REL)).toBe(true);
		expect(artifactExists(t.root, BLOCKED_REL)).toBe(true);
		expect(artifactExists(t.root, PR_REL)).toBe(false);
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("audit mismatch");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		// No commit → no events
		const events = readEvents(t.root);
		expect(events.some((e) => e.cmd === "write-verification")).toBe(false);
		expect(events.some((e) => e.cmd === "write-pr")).toBe(false);
	});

	it("AC-20: clean audit deletes stale .audit-blocked and VERIFICATION-AUDIT.md", async () => {
		// Seed stale markers from a prior mismatched run
		writeArtifact(t.root, BLOCKED_REL, "stale\n");
		writeArtifact(t.root, AUDIT_REL, "# stale audit\n");
		expect(artifactExists(t.root, BLOCKED_REL)).toBe(true);
		expect(artifactExists(t.root, AUDIT_REL)).toBe(true);

		writeWorktreeArtifact(t, "VERIFICATION.md", "All ACs PASS.");
		writeWorktreeArtifact(t, "PR.md", "pr");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		expect(artifactExists(t.root, BLOCKED_REL)).toBe(false);
		expect(artifactExists(t.root, AUDIT_REL)).toBe(false);
	});

	it("AC-21: happy path writes VERIFICATION.md and flips phase_run to completed", async () => {
		writeWorktreeArtifact(t, "VERIFICATION.md", "All ACs PASS.");
		writeWorktreeArtifact(t, "PR.md", "pr");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		expect(artifactExists(t.root, V_REL)).toBe(true);
		const run = t.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(t.sliceId, "verify") as { status: string } | undefined;
		expect(run?.status).toBe("completed");
	});

	it("AC-22: happy path appends write-pr event (ship precondition)", async () => {
		writeWorktreeArtifact(t, "VERIFICATION.md", "All ACs PASS.");
		writeWorktreeArtifact(t, "PR.md", "pr");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const events = readEvents(t.root);
		const writePrEvents = events.filter(
			(e) => e.cmd === "write-pr" && (e.params as { sliceId?: string }).sliceId === t.sliceId,
		);
		expect(writePrEvents.length).toBeGreaterThanOrEqual(1);
		expect(artifactExists(t.root, PR_REL)).toBe(true);
	});

	it("AC-23: happy path emits exactly one phase_complete", async () => {
		writeWorktreeArtifact(t, "VERIFICATION.md", "All ACs PASS.");
		writeWorktreeArtifact(t, "PR.md", "pr");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const completes = t.emitted.filter((e) => e.type === "phase_complete");
		expect(completes).toHaveLength(1);
		expect(completes[0]?.phase).toBe("verify");
		expect(t.emitted.some((e) => e.type === "phase_failed")).toBe(false);
	});

	it("AC-24: idempotent — second invocation leaves phase_run completed, re-emits phase_complete", async () => {
		writeWorktreeArtifact(t, "VERIFICATION.md", "All ACs PASS.");
		writeWorktreeArtifact(t, "PR.md", "pr");
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		t.emitted.length = 0;
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const run = t.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(t.sliceId, "verify") as { status: string };
		expect(run.status).toBe("completed");
		const completeEvents = t.emitted.filter((e) => e.type === "phase_complete");
		expect(completeEvents.length).toBeGreaterThanOrEqual(1);
	});

	it("Fix-3: symlink for VERIFICATION.md → phase_failed with 'symlink' in reason; no phase_complete; no commit; phase_run stays 'started'", async () => {
		// Create VERIFICATION.md as a symlink pointing outside the worktree.
		const artifactsDir = join(t.worktreePath, ".pi", ".tff", "artifacts");
		const symlinkTarget = join(t.root, "outside-target.txt");
		writeFileSync(symlinkTarget, "should not be read\n");
		symlinkSync(symlinkTarget, join(artifactsDir, "VERIFICATION.md"));
		// PR.md is a regular file — should not matter because we reject on VERIFICATION.md first.
		writeWorktreeArtifact(t, "PR.md", "pr content");

		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });

		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("symlink");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);

		// phase_run must still be 'started' (no commit happened).
		const run = t.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(t.sliceId, "verify") as { status: string } | undefined;
		expect(run?.status).toBe("started");

		// No events logged (no commit).
		const { readEvents } = await import("../../../src/common/event-log.js");
		expect(readEvents(t.root)).toHaveLength(0);
	});
});
