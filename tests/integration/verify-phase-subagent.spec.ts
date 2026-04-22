import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactExists, initTffDirectory, writeArtifact } from "../../src/common/artifacts.js";
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
	updateTaskStatus,
} from "../../src/common/db.js";
import { readEvents } from "../../src/common/event-log.js";
import type { PhaseContext } from "../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../src/common/settings.js";
import {
	__resetFinalizersForTest,
	registerDispatchHook,
} from "../../src/common/subagent-dispatcher.js";
import { registerPhaseFinalizers } from "../../src/phases/finalizers.js";
import fixture from "../fixtures/subagent-details-verify.json";
import { must } from "../helpers.js";

// Per-slice worktree path: separate tmp dir so finalizer's artifact-source
// (wtPath/.pi/.tff/artifacts/) does not collide with finalizer's artifact
// destination (root/.pi/.tff/milestones/.../slices/...).
let worktreePath = "";

vi.mock("../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn(() => worktreePath),
}));

const mockedGitDirty = vi.fn<(cwd: string) => string[] | null>().mockReturnValue([]);
vi.mock("../../src/common/git.js", () => ({
	getDiff: vi.fn().mockReturnValue("diff content"),
	gitEnv: vi.fn().mockReturnValue({}),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
	getDefaultBranch: vi.fn().mockReturnValue("main"),
	getTrackedDirtyEntries: (cwd: string) => mockedGitDirty(cwd),
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

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface TestPi {
	handlers: Record<string, Handler[]>;
	listeners: Record<string, Array<(e: unknown) => void>>;
	on(evt: string, h: Handler): void;
	events: {
		on(channel: string, l: (e: unknown) => void): void;
		emit(channel: string, payload: unknown): void;
	};
	sendUserMessage(msg: string): void;
	userMessages: string[];
}

function makePi(): TestPi {
	const handlers: Record<string, Handler[]> = {};
	const listeners: Record<string, Array<(e: unknown) => void>> = {};
	const userMessages: string[] = [];
	return {
		handlers,
		listeners,
		userMessages,
		on(evt, h) {
			const list = handlers[evt] ?? [];
			list.push(h);
			handlers[evt] = list;
		},
		events: {
			on(channel, l) {
				const list = listeners[channel] ?? [];
				list.push(l);
				listeners[channel] = list;
			},
			emit(channel, payload) {
				for (const l of listeners[channel] ?? []) l(payload);
			},
		},
		sendUserMessage(msg) {
			userMessages.push(msg);
		},
	};
}

async function fireToolResult(pi: TestPi, event: unknown, root: string): Promise<void> {
	const list = pi.handlers.tool_result ?? [];
	for (const h of list) await h(event, { projectRoot: root });
}

interface FullCtx {
	db: Database.Database;
	root: string;
	worktreePath: string;
	sliceId: string;
	taskIds: string[];
	pi: TestPi;
	phaseCtx: PhaseContext;
	emitted: Array<{ type: string; [k: string]: unknown }>;
}

const SLICE_DIR = "milestones/M01/slices/M01-S01";
const V_REL = `${SLICE_DIR}/VERIFICATION.md`;
const PR_REL = `${SLICE_DIR}/PR.md`;
const BLOCKED_REL = `${SLICE_DIR}/.audit-blocked`;

function sliceArtifactPath(ctx: FullCtx, rel: string): string {
	return join(ctx.root, ".pi", ".tff", rel);
}

async function createFullCtx(): Promise<FullCtx> {
	const db = openDatabase(":memory:");
	applyMigrations(db);

	const root = mkdtempSync(join(tmpdir(), "tff-verify-int-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-verify-int-wt-"));
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

	// Seed SPEC/PLAN so verifyPhase.prepare can read them.
	writeArtifact(root, `${SLICE_DIR}/SPEC.md`, "# Spec\nAC-1: thing works");
	writeArtifact(root, `${SLICE_DIR}/PLAN.md`, "# Plan\n- T01: task");

	// Persisted plan tasks, all closed — the BLOCKED branch resets them to open.
	const taskIds = [
		insertTask(db, { sliceId, number: 1, title: "T01" }),
		insertTask(db, { sliceId, number: 2, title: "T02" }),
	];
	for (const id of taskIds) updateTaskStatus(db, id, "closed");

	const pi = makePi();
	const tffCtx = {
		db,
		projectRoot: root,
		settings: DEFAULT_SETTINGS,
	} as unknown as Parameters<typeof registerDispatchHook>[1];
	registerDispatchHook(pi as never, tffCtx);

	const emitted: Array<{ type: string; [k: string]: unknown }> = [];
	pi.events.on("tff:phase", (e) => {
		emitted.push(e as { type: string; [k: string]: unknown });
	});

	const slice = must(getSlice(db, sliceId));
	const phaseCtx: PhaseContext = {
		pi: pi as unknown as PhaseContext["pi"],
		db,
		root,
		slice,
		milestoneNumber: 1,
		settings: DEFAULT_SETTINGS,
	};

	return { db, root, worktreePath, sliceId, taskIds, pi, phaseCtx, emitted };
}

function cloneFixture(): typeof fixture {
	return structuredClone(fixture);
}

describe("verify phase → subagent → finalizer (end-to-end)", () => {
	let ctx: FullCtx;

	beforeEach(() => {
		__resetFinalizersForTest();
		registerPhaseFinalizers();
	});

	afterEach(() => {
		try {
			rmSync(ctx.root, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(ctx.worktreePath, { recursive: true, force: true });
		} catch {}
		ctx.db.close();
	});

	it("happy path: dispatch → stubbed subagent → phase_complete + phase_run completed + write-pr event", async () => {
		ctx = await createFullCtx();

		// Pre-write artifacts that the simulated subagent would have written.
		// Fixture's bash result has isError=false for `bun test`, so the
		// "all pass" claim below audits clean.
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "VERIFICATION.md"),
			"AC-1: [x] passed\n\nRan `bun test` — all pass.",
			"utf-8",
		);
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "PR.md"),
			"## Summary\nWired subagent verify.",
			"utf-8",
		);

		// Clear start event before finalizer runs.
		await verifyPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;

		await fireToolResult(ctx.pi, fixture, ctx.root);

		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(true);
		expect(ctx.emitted.some((e) => e.type === "phase_failed")).toBe(false);

		const run = ctx.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(ctx.sliceId, "verify") as { status: string } | undefined;
		expect(run?.status).toBe("completed");

		const events = readEvents(ctx.root);
		expect(
			events.some(
				(e) => e.cmd === "write-pr" && (e.params as { sliceId?: string }).sliceId === ctx.sliceId,
			),
		).toBe(true);
		expect(
			events.some(
				(e) =>
					e.cmd === "write-verification" &&
					(e.params as { sliceId?: string }).sliceId === ctx.sliceId,
			),
		).toBe(true);

		expect(artifactExists(ctx.root, V_REL)).toBe(true);
		expect(artifactExists(ctx.root, PR_REL)).toBe(true);
	});

	it("BLOCKED variant: STATUS:BLOCKED → phase_failed with evidence + tasks reset to open", async () => {
		ctx = await createFullCtx();

		const blocked = cloneFixture();
		const r0 = blocked.details.results[0];
		if (!r0) throw new Error("fixture missing result[0]");
		r0.finalOutput = "STATUS: BLOCKED\nEVIDENCE: AC-2 test not found";
		// Mirror finalOutput in the final assistant text so extractText is consistent.
		const lastAssistant = r0.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && m.content[0]?.type === "text",
		);
		if (lastAssistant && Array.isArray(lastAssistant.content)) {
			for (const part of lastAssistant.content) {
				if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
					(part as { text: string }).text = "STATUS: BLOCKED\nEVIDENCE: AC-2 test not found";
				}
			}
		}

		await verifyPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;

		await fireToolResult(ctx.pi, blocked, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(failed?.phase).toBe("verify");
		expect(String(failed?.error)).toContain("AC-2 test not found");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);

		// Tasks reset to open.
		const tasks = getTasks(ctx.db, ctx.sliceId);
		expect(tasks.length).toBeGreaterThan(0);
		for (const t of tasks) expect(t.status).toBe("open");

		// No commits.
		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "write-pr")).toBe(false);
		expect(events.some((e) => e.cmd === "write-verification")).toBe(false);
	});

	it("audit mismatch variant: claim 'all pass' but bash isError=true → .audit-blocked + phase_failed + no write-pr", async () => {
		ctx = await createFullCtx();

		const bad = cloneFixture();
		const r0 = bad.details.results[0];
		if (!r0) throw new Error("fixture missing result[0]");
		// Mutate the bash toolResult to isError=true while keeping STATUS: DONE.
		const tr = r0.messages.find((m) => m.role === "toolResult") as { isError: boolean } | undefined;
		if (!tr) throw new Error("fixture missing toolResult");
		tr.isError = true;

		// Subagent would have written VERIFICATION.md claiming pass.
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "VERIFICATION.md"),
			"Ran `bun test` — all pass.",
			"utf-8",
		);
		writeFileSync(join(ctx.worktreePath, ".pi", ".tff", "artifacts", "PR.md"), "pr body", "utf-8");

		await verifyPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;

		await fireToolResult(ctx.pi, bad, ctx.root);

		expect(existsSync(sliceArtifactPath(ctx, BLOCKED_REL))).toBe(true);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("audit mismatch");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);

		// No write-pr event.
		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "write-pr")).toBe(false);
		expect(events.some((e) => e.cmd === "write-verification")).toBe(false);
	});

	it("reviewer modified tracked file → phase_failed before artifact read + no write-pr", async () => {
		ctx = await createFullCtx();

		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "VERIFICATION.md"),
			"AC-1: [x] passed",
			"utf-8",
		);
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "PR.md"),
			"## Summary",
			"utf-8",
		);

		mockedGitDirty.mockReturnValueOnce([" M src/app.ts", "?? extra.log"].slice(0, 1));

		await verifyPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;

		await fireToolResult(ctx.pi, fixture, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("reviewer modified tracked files");
		expect(String(failed?.error)).toContain("src/app.ts");

		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "write-pr")).toBe(false);
		expect(events.some((e) => e.cmd === "write-verification")).toBe(false);

		mockedGitDirty.mockReturnValue([]);
	});
});
