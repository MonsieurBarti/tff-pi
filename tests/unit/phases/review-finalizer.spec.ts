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
	getTasks,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import { readEvents } from "../../../src/common/event-log.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import {
	type DispatchResult,
	type FinalizeInput,
	type FinalizeOutcome,
	type Finalizer,
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../../src/common/subagent-dispatcher.js";
import { registerPhaseFinalizers } from "../../../src/phases/finalizers.js";
import { must } from "../../helpers.js";

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
	getTrackedDirtyEntries: vi.fn().mockReturnValue([]),
}));

vi.mock("../../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Reviewer", protocol: "# Protocol" }),
	loadAgentResource: vi.fn(() => "---\nname: tff-security-auditor\n---\nSecurity body\n"),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
	PHASE_TOOLS: { review: [] },
}));

import { reviewPhase } from "../../../src/phases/review.js";

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
const REVIEW_REL = `${SLICE_DIR}/REVIEW.md`;

function seedCtx(): TestCtx {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-review-fin-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-review-fin-wt-"));
	initTffDirectory(root);
	mkdirSync(join(worktreePath, ".pi", ".tff", "artifacts"), { recursive: true });

	insertProject(db, { name: "TFF", vision: "V" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, "SS");
	db.prepare("UPDATE slice SET status = 'reviewing' WHERE id = ?").run(sliceId);
	insertPhaseRun(db, {
		sliceId,
		phase: "review",
		status: "started",
		startedAt: new Date().toISOString(),
	});
	// Seed a few tasks (closed) so the denied branch can reset them.
	for (const n of [1, 2]) {
		const tid = insertTask(db, { sliceId, number: n, title: `T${n}`, wave: 0 });
		db.prepare("UPDATE task SET status = 'closed' WHERE id = ?").run(tid);
	}
	writeArtifact(root, `${SLICE_DIR}/SPEC.md`, "# Spec\nAC-1: foo");
	writeArtifact(root, `${SLICE_DIR}/PLAN.md`, "# Plan");
	writeArtifact(root, `${SLICE_DIR}/VERIFICATION.md`, "# Verified");

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
		results: [{ status: "BLOCKED", summary: "", evidence, exitCode: 1 }],
	};
}

function doneResult(): DispatchResult {
	return {
		mode: "single",
		capturedAt: "",
		results: [{ status: "DONE", summary: "ok", evidence: "reviewed", exitCode: 0 }],
	};
}

function needsContextResult(evidence: string): DispatchResult {
	return {
		mode: "single",
		capturedAt: "",
		results: [{ status: "NEEDS_CONTEXT", summary: "", evidence, exitCode: 0 }],
	};
}

function writeReviewArtifact(t: TestCtx, content: string): void {
	writeFileSync(join(t.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"), content, "utf-8");
}

function getFinalizer(): Finalizer {
	const f = __getFinalizerForTest("review");
	if (!f) throw new Error("review finalizer not registered");
	return f;
}

function invokeFinalizer(
	t: TestCtx,
	input: { result: DispatchResult; calls: FinalizeInput["calls"] },
	// biome-ignore lint/suspicious/noConfusingVoidType: matches Finalizer return type in production
): Promise<FinalizeOutcome | void> {
	return getFinalizer()({
		pi: t.pi as unknown as FinalizeInput["pi"],
		db: t.db,
		root: t.root,
		settings: DEFAULT_SETTINGS,
		config: { mode: "single", phase: "review", sliceId: t.sliceId, tasks: [] },
		result: input.result,
		calls: input.calls,
	});
}

describe("review finalizer", () => {
	let t: TestCtx;

	beforeEach(async () => {
		__resetFinalizersForTest();
		registerPhaseFinalizers();
		t = seedCtx();
		await reviewPhase.prepare(makePhaseCtx(t));
		t.emitted.length = 0;
	});

	afterEach(() => {
		rmSync(t.root, { recursive: true, force: true });
		rmSync(t.worktreePath, { recursive: true, force: true });
		t.db.close();
	});

	it("AC-10: BLOCKED result → phase_failed with evidence; no copy; no commit; no task reset", async () => {
		await invokeFinalizer(t, {
			result: blockedResult("agent gave up"),
			calls: [],
		});
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("agent gave up");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
		// tasks still closed
		const tasks = getTasks(t.db, t.sliceId);
		for (const task of tasks) expect(task.status).toBe("closed");
	});

	it("AC-10b: NEEDS_CONTEXT result → phase_failed with evidence; no copy; no commit; tasks untouched", async () => {
		await invokeFinalizer(t, {
			result: needsContextResult("need more info about diff"),
			calls: [],
		});
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("need more info about diff");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
		const tasks = getTasks(t.db, t.sliceId);
		for (const task of tasks) expect(task.status).toBe("closed");
	});

	it("AC-11: missing REVIEW.md → phase_failed 'missing REVIEW.md'; no commit", async () => {
		await invokeFinalizer(t, { result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("missing REVIEW.md");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
	});

	it("AC-12: symlink REVIEW.md → phase_failed 'symlink rejected'; no read/copy/commit", async () => {
		const targetDir = mkdtempSync(join(tmpdir(), "tff-review-target-"));
		writeFileSync(join(targetDir, "REVIEW.md"), "should not be read\n\nVERDICT: approved", "utf-8");
		symlinkSync(
			join(targetDir, "REVIEW.md"),
			join(t.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
		);
		await invokeFinalizer(t, { result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(String(failed?.error)).toMatch(/symlink rejected: REVIEW\.md/);
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
		rmSync(targetDir, { recursive: true, force: true });
	});

	it("AC-13: malformed VERDICT → phase_failed 'missing or malformed VERDICT'; no copy; no commit", async () => {
		writeReviewArtifact(t, "## Summary\nNo trailer line.");
		await invokeFinalizer(t, { result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("missing or malformed VERDICT");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(false);
		expect(readEvents(t.root)).toHaveLength(0);
	});

	it("AC-14: denied verdict → copy + review-rejected commit + phase_failed + tasks reset + slice=executing", async () => {
		writeReviewArtifact(
			t,
			"## Summary\nCritical issues found.\n\n## Tasks to rework\n- T01\n\nVERDICT: denied",
		);
		await invokeFinalizer(t, { result: doneResult(), calls: [] });

		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("Review verdict: denied");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(true);

		const events = readEvents(t.root);
		expect(events.some((e) => e.cmd === "review-rejected")).toBe(true);
		expect(events.some((e) => e.cmd === "write-review")).toBe(false);

		const sliceRow = t.db.prepare("SELECT status FROM slice WHERE id = ?").get(t.sliceId) as {
			status: string;
		};
		expect(sliceRow.status).toBe("executing");
		const tasks = getTasks(t.db, t.sliceId);
		for (const task of tasks) expect(task.status).toBe("open");
	});

	it("AC-15, 16, 17: approved → copy + write-review commit + phase_complete + phase_run completed", async () => {
		writeReviewArtifact(t, "## Summary\nLGTM.\n\nVERDICT: approved");
		await invokeFinalizer(t, { result: doneResult(), calls: [] });

		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(true);
		expect(t.emitted.some((e) => e.type === "phase_failed")).toBe(false);
		expect(artifactExists(t.root, REVIEW_REL)).toBe(true);

		const events = readEvents(t.root);
		expect(events.some((e) => e.cmd === "write-review")).toBe(true);

		const run = t.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(t.sliceId, "review") as { status: string } | undefined;
		expect(run?.status).toBe("completed");
	});

	it("AC-18: approved idempotency — second invocation skips write-review commit; re-emits phase_complete", async () => {
		writeReviewArtifact(t, "## Summary\nLGTM.\n\nVERDICT: approved");
		await invokeFinalizer(t, { result: doneResult(), calls: [] });
		t.emitted.length = 0;
		await invokeFinalizer(t, { result: doneResult(), calls: [] });

		const writeReviewEvents = readEvents(t.root).filter((e) => e.cmd === "write-review");
		expect(writeReviewEvents).toHaveLength(1);
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(true);

		const run = t.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(t.sliceId, "review") as { status: string };
		expect(run.status).toBe("completed");
	});

	it("trailing-VERDICT wins: prose body quoting earlier VERDICT line does not swallow real trailer (security hardening)", async () => {
		writeReviewArtifact(
			t,
			[
				"## Summary",
				"We considered `VERDICT: approved` for AC-1 alone, but AC-14 has a critical failure.",
				"",
				"VERDICT: approved",
				"",
				"## Tasks to rework",
				"- T05",
				"",
				"VERDICT: denied",
			].join("\n"),
		);
		await invokeFinalizer(t, { result: doneResult(), calls: [] });

		// Last VERDICT line is "denied" → finalizer must route to the denied branch,
		// not the approved one (regex was buggy when it took the first match).
		const failed = t.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("Review verdict: denied");
		expect(t.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		const events = readEvents(t.root);
		expect(events.some((e) => e.cmd === "review-rejected")).toBe(true);
		expect(events.some((e) => e.cmd === "write-review")).toBe(false);
	});

	it("AC-19: denied idempotency — second invocation tolerated, artifact overwritten", async () => {
		writeReviewArtifact(t, "## Summary\nFail.\n\nVERDICT: denied");
		await invokeFinalizer(t, { result: doneResult(), calls: [] });
		t.emitted.length = 0;
		await invokeFinalizer(t, { result: doneResult(), calls: [] });

		// Tasks stay open (already reset first time, projection no-ops second time)
		const tasks = getTasks(t.db, t.sliceId);
		for (const task of tasks) expect(task.status).toBe("open");
		expect(
			t.emitted.filter((e) => e.type === "phase_failed" && e.error === "Review verdict: denied")
				.length,
		).toBeGreaterThanOrEqual(1);
	});
});
