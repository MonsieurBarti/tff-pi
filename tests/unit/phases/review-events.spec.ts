import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import {
	type DispatchResult,
	type Finalizer,
	__getFinalizerForTest,
	__resetFinalizersForTest,
} from "../../../src/common/subagent-dispatcher.js";
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
	sliceId: string;
	emitted: Array<{ type: string; [k: string]: unknown }>;
	phaseCtx: PhaseContext;
}

function doneResult(): DispatchResult {
	return {
		mode: "single",
		capturedAt: "",
		results: [{ status: "DONE", summary: "ok", evidence: "reviewed", exitCode: 0 }],
	};
}

function blockedResult(evidence: string): DispatchResult {
	return {
		mode: "single",
		capturedAt: "",
		results: [{ status: "BLOCKED", summary: "", evidence, exitCode: 1 }],
	};
}

function getFinalizer(): Finalizer {
	const f = __getFinalizerForTest("review");
	if (!f) throw new Error("review finalizer not registered");
	return f;
}

describe("reviewPhase event emission (finalizer-driven)", () => {
	let t: TestCtx;

	beforeEach(async () => {
		__resetFinalizersForTest();
		const db = openDatabase(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-review-events-root-"));
		worktreePath = mkdtempSync(join(tmpdir(), "tff-review-events-wt-"));
		initTffDirectory(root);
		mkdirSync(join(worktreePath, ".pi", ".tff", "artifacts"), { recursive: true });
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("reviewing", sliceId);
		updateSliceTier(db, sliceId, "SS");
		insertPhaseRun(db, {
			sliceId,
			phase: "review",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
		writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verified");

		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const slice = must(getSlice(db, sliceId));
		const phaseCtx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: {
					emit: (ch: string, ev: unknown) => {
						if (ch === "tff:phase") emitted.push(ev as { type: string; [k: string]: unknown });
					},
					on: vi.fn(),
				},
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};

		t = { db, root, sliceId, emitted, phaseCtx };
		await reviewPhase.prepare(phaseCtx);
	});

	afterEach(() => {
		rmSync(t.root, { recursive: true, force: true });
		rmSync(worktreePath, { recursive: true, force: true });
		t.db.close();
	});

	it("prepare() emits phase_start exactly once with base event fields", () => {
		const starts = t.emitted.filter((e) => e.type === "phase_start" && e.phase === "review");
		expect(starts).toHaveLength(1);
		const event = starts[0];
		expect(event).toHaveProperty("sliceId");
		expect(event).toHaveProperty("sliceLabel", "M01-S01");
		expect(event).toHaveProperty("milestoneNumber", 1);
		expect(event).toHaveProperty("timestamp");
	});

	it("prepare() does NOT emit phase_complete (finalizer owns completion signal)", () => {
		const completes = t.emitted.filter((e) => e.type === "phase_complete");
		expect(completes).toHaveLength(0);
	});

	it("finalizer emits phase_complete on approved VERDICT", async () => {
		writeFileSync(
			join(worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"## Summary\nOK.\n\nVERDICT: approved",
			"utf-8",
		);
		t.emitted.length = 0;
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		expect(t.emitted.some((e) => e.type === "phase_complete" && e.phase === "review")).toBe(true);
	});

	it("finalizer emits phase_failed('Review verdict: denied') on denied VERDICT", async () => {
		writeFileSync(
			join(worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"## Summary\nFail.\n\nVERDICT: denied",
			"utf-8",
		);
		t.emitted.length = 0;
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed" && e.phase === "review");
		expect(failed?.error).toBe("Review verdict: denied");
	});

	it("finalizer emits phase_failed('missing REVIEW.md') when artifact missing", async () => {
		t.emitted.length = 0;
		await getFinalizer()({ root: t.root, result: doneResult(), calls: [] });
		const failed = t.emitted.find((e) => e.type === "phase_failed" && e.phase === "review");
		expect(failed?.error).toBe("missing REVIEW.md");
	});

	it("finalizer emits phase_failed with evidence on BLOCKED result", async () => {
		t.emitted.length = 0;
		await getFinalizer()({
			root: t.root,
			result: blockedResult("agent crashed"),
			calls: [],
		});
		const failed = t.emitted.find((e) => e.type === "phase_failed" && e.phase === "review");
		expect(failed?.error).toBe("agent crashed");
	});
});
