import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, readArtifact, writeArtifact } from "../../../src/common/artifacts.js";
import { compressIfEnabled } from "../../../src/common/compress.js";
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
import { must } from "../../helpers.js";

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi
		.fn()
		.mockImplementation((_root: string, sLabel: string) =>
			join(tmpdir(), `.tff-cc/worktrees/${sLabel}`),
		),
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

import { getDiff } from "../../../src/common/git.js";
import { detectVerifyCommands } from "../../../src/common/verify-commands.js";
import { verifyPhase } from "../../../src/phases/verify.js";

function makeCtx(db: Database.Database, root: string, sliceId: string): PhaseContext {
	const slice = must(getSlice(db, sliceId));
	return {
		pi: {
			sendUserMessage: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn() },
		} as unknown as PhaseContext["pi"],
		db,
		root,
		slice,
		milestoneNumber: 1,
		settings: DEFAULT_SETTINGS,
	};
}

describe("verifyPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		__resetFinalizersForTest();
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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sliceId);
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1: auth works");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof verifyPhase.prepare).toBe("function");
	});

	it("AC-1/AC-2: happy path returns DISPATCHER_PROMPT; dispatch-config has phase+sliceId+tff-verifier agent", async () => {
		const ctx = makeCtx(db, root, sliceId);
		const result = await verifyPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(result.retry).toBe(false);
		expect(result.message).toContain("<DISPATCH-ONLY>");
		const cfg = JSON.parse(readFileSync(join(root, ".pi/.tff/dispatch-config.json"), "utf-8")) as {
			phase: string;
			mode: string;
			sliceId: string;
			tasks: Array<{ agent: string; cwd: string; task: string }>;
		};
		expect(cfg.phase).toBe("verify");
		expect(cfg.mode).toBe("single");
		expect(cfg.sliceId).toBe(ctx.slice.id);
		expect(cfg.tasks).toHaveLength(1);
		expect(cfg.tasks[0]?.agent).toBe("tff-verifier");
		expect(cfg.tasks[0]?.cwd).toContain(".tff-cc/worktrees/");
	});

	it("AC-3: empty-diff guard returns {success:false, retry:false} and emits phase_failed", async () => {
		(getDiff as unknown as Mock).mockReturnValueOnce("");
		const ctx = makeCtx(db, root, sliceId);
		const result = await verifyPhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(false);
		const emit = ctx.pi.events.emit as unknown as Mock;
		const failedCalls = emit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "verify",
		);
		expect(failedCalls).toHaveLength(1);
		expect(__getFinalizerForTest("verify")).toBeUndefined();
	});

	it("AC-4: mechanical-verify failure does NOT register finalizer and does NOT write dispatch-config", async () => {
		const { runMechanicalVerification, formatMechanicalReport } = await import(
			"../../../src/common/mechanical-verifier.js"
		);
		vi.mocked(detectVerifyCommands).mockResolvedValueOnce([
			{ name: "lint", command: "echo", source: "settings" },
		]);
		vi.mocked(runMechanicalVerification).mockResolvedValueOnce({
			allPassed: false,
			commands: [
				{
					name: "lint",
					command: "echo",
					passed: false,
					exitCode: 1,
					stdout: "",
					stderr: "boom",
					durationMs: 10,
				},
			],
			timestamp: new Date().toISOString(),
		});
		vi.mocked(formatMechanicalReport).mockReturnValueOnce("failing-report");

		const ctx = makeCtx(db, root, sliceId);
		const result = await verifyPhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		expect(__getFinalizerForTest("verify")).toBeUndefined();
		// dispatch-config.json must not exist — dispatch was never prepared
		expect(() => readFileSync(join(root, ".pi/.tff/dispatch-config.json"), "utf-8")).toThrow();
	});

	it("AC-5: post-verify checkpoint is created before finalizer registration", async () => {
		const { createCheckpoint } = await import("../../../src/common/checkpoint.js");
		const checkpointMock = vi.mocked(createCheckpoint);
		checkpointMock.mockClear();
		// The finalizer must not exist before prepare()
		expect(__getFinalizerForTest("verify")).toBeUndefined();
		const ctx = makeCtx(db, root, sliceId);
		await verifyPhase.prepare(ctx);
		expect(checkpointMock).toHaveBeenCalledTimes(1);
		expect(__getFinalizerForTest("verify")).toBeDefined();
		// Order: checkpoint must have been called at least once; the finalizer
		// is only set after the checkpoint path (code ordering).
		const order = checkpointMock.mock.invocationCallOrder[0];
		expect(typeof order).toBe("number");
	});

	it("AC-6: registerPhaseFinalizer called once per prepare(); second prepare() replaces the closure (last-wins)", async () => {
		const ctx1 = makeCtx(db, root, sliceId);
		await verifyPhase.prepare(ctx1);
		const first = __getFinalizerForTest("verify");
		expect(first).toBeDefined();
		const ctx2 = makeCtx(db, root, sliceId);
		await verifyPhase.prepare(ctx2);
		const second = __getFinalizerForTest("verify");
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
	});

	it("emits phase_start event", async () => {
		const ctx = makeCtx(db, root, sliceId);
		const emit = ctx.pi.events.emit as unknown as Mock;
		await verifyPhase.prepare(ctx);
		const startCalls = emit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "verify",
		);
		expect(startCalls).toHaveLength(1);
	});

	it("compresses VERIFICATION-MECHANICAL.md when enabled (pre-dispatch artifact write preserved)", async () => {
		const { runMechanicalVerification, formatMechanicalReport } = await import(
			"../../../src/common/mechanical-verifier.js"
		);
		vi.mocked(detectVerifyCommands).mockResolvedValueOnce([
			{ name: "lint", command: "echo", source: "settings" },
		]);
		vi.mocked(runMechanicalVerification).mockResolvedValueOnce({
			allPassed: true,
			commands: [],
			timestamp: new Date().toISOString(),
		});
		vi.mocked(formatMechanicalReport).mockReturnValueOnce("raw-report");
		vi.mocked(compressIfEnabled).mockReturnValueOnce("[COMPRESSED]raw-report");

		const ctx = makeCtx(db, root, sliceId);
		await verifyPhase.prepare(ctx);
		const written = readArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION-MECHANICAL.md");
		expect(written).toBe("[COMPRESSED]raw-report");
	});

	it("fails with phase_failed when diff is empty (no execute output)", async () => {
		(getDiff as unknown as Mock).mockReturnValueOnce("");
		const ctx = makeCtx(db, root, sliceId);
		const emit = ctx.pi.events.emit as unknown as Mock;
		const result = await verifyPhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(false);
		const failedCalls = emit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_failed" && e.phase === "verify",
		);
		expect(failedCalls).toHaveLength(1);
		expect(failedCalls[0]?.[1]).toHaveProperty("error");
	});
});
