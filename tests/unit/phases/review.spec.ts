import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import {
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

const SECURITY_LENS_BODY = "Security-lens body: OWASP checks and injection review.";

vi.mock("../../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Reviewer", protocol: "# Protocol" }),
	loadAgentResource: vi.fn(() => `---\nname: tff-security-auditor\n---\n${SECURITY_LENS_BODY}\n`),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
	PHASE_TOOLS: {
		review: [],
	},
}));

import { PHASE_TOOLS } from "../../../src/orchestrator.js";
import { reviewPhase } from "../../../src/phases/review.js";

describe("reviewPhase — dispatch shape (M01-S04)", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		__resetFinalizersForTest();
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-review-test-"));
		worktreePath = mkdtempSync(join(tmpdir(), "tff-review-wt-"));
		initTffDirectory(root);
		mkdirSync(join(worktreePath, ".pi", ".tff", "artifacts"), { recursive: true });
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("reviewing", sliceId);
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
		writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verified");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(worktreePath, { recursive: true, force: true });
		db.close();
	});

	function makeCtx(): {
		ctx: PhaseContext;
		emitted: Array<{ type: string; [k: string]: unknown }>;
	} {
		const emitted: Array<{ type: string; [k: string]: unknown }> = [];
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
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
		return { ctx, emitted };
	}

	it("AC-1: returns DISPATCHER_PROMPT on happy path", async () => {
		const { ctx } = makeCtx();
		const result = await reviewPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(result.message).toBeDefined();
		expect(String(result.message)).toMatch(/subagent/i);
	});

	it("AC-2: dispatch-config.json carries phase=review, mode=parallel (one task), sliceId, tff-code-reviewer", async () => {
		// Parallel-with-one-task avoids pi-subagents' single-mode agent-discovery
		// bug: top-level cwd → findNearestProjectRoot stops at worktree's .pi/
		// and misses the repo-root .pi/agents/. Parallel uses per-task cwd only.
		const { ctx } = makeCtx();
		await reviewPhase.prepare(ctx);
		const cfg = JSON.parse(
			readFileSync(join(root, ".pi", ".tff", "dispatch-config.json"), "utf-8"),
		);
		expect(cfg.phase).toBe("review");
		expect(cfg.mode).toBe("parallel");
		expect(cfg.sliceId).toBe(sliceId);
		expect(cfg.tasks).toHaveLength(1);
		expect(cfg.tasks[0].agent).toBe("tff-code-reviewer");
		expect(cfg.tasks[0].cwd).toBe(worktreePath);
	});

	it("AC-3: task body includes SPEC, PLAN, VERIFICATION, Security-lens reference in order (front-matter stripped)", async () => {
		const { ctx } = makeCtx();
		await reviewPhase.prepare(ctx);
		const cfg = JSON.parse(
			readFileSync(join(root, ".pi", ".tff", "dispatch-config.json"), "utf-8"),
		);
		const taskBody: string = cfg.tasks[0].task;
		const specIdx = taskBody.indexOf("## SPEC.md");
		const planIdx = taskBody.indexOf("## PLAN.md");
		const verIdx = taskBody.indexOf("## VERIFICATION.md");
		const secIdx = taskBody.indexOf("## Security-lens reference");
		expect(specIdx).toBeGreaterThan(-1);
		expect(planIdx).toBeGreaterThan(specIdx);
		expect(verIdx).toBeGreaterThan(planIdx);
		expect(secIdx).toBeGreaterThan(verIdx);
		// Security-lens body is stripped of front-matter
		expect(taskBody).toContain(SECURITY_LENS_BODY);
		const secSection = taskBody.slice(secIdx);
		expect(secSection).not.toContain("name: tff-security-auditor");
	});

	it("AC-4: review finalizer is a singleton registered at extension init", async () => {
		expect(__getFinalizerForTest("review")).toBeUndefined();
		registerPhaseFinalizers();
		const fn1 = __getFinalizerForTest("review");
		expect(fn1).toBeDefined();
		// prepare() does NOT re-register; the finalizer is stateless and
		// reconstructs context from config.sliceId + DB + disk each invocation.
		const { ctx } = makeCtx();
		await reviewPhase.prepare(ctx);
		expect(__getFinalizerForTest("review")).toBe(fn1);
	});

	it("AC-6: phase_start event emitted during prepare()", async () => {
		const { ctx, emitted } = makeCtx();
		await reviewPhase.prepare(ctx);
		const startIdx = emitted.findIndex((e) => e.type === "phase_start" && e.phase === "review");
		expect(startIdx).toBe(0);
	});

	it("structural: PHASE_TOOLS.review is []", () => {
		expect(PHASE_TOOLS.review).toEqual([]);
	});

	it("structural: review.md protocol uses subagent-dispatch phrasing, not HARD-GATE", () => {
		const body = readFileSync("src/resources/protocols/review.md", "utf-8");
		expect(body).not.toContain("HARD-GATE");
		expect(body).not.toContain("tff_write_review");
		expect(body).toMatch(/single subagent dispatch/);
		expect(body).toMatch(/VERDICT:/);
	});

	it("structural: tff-code-reviewer.md allowlists read, bash, write, find, grep", () => {
		const body = readFileSync("src/resources/agents/tff-code-reviewer.md", "utf-8");
		expect(body).toMatch(/^tools:\s*read,\s*bash,\s*write,\s*find,\s*grep\s*$/m);
		expect(body).toMatch(/VERDICT:\s*approved/);
		expect(body).toMatch(/uncompressed/i);
	});
});
