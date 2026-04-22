import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import fixture from "../fixtures/subagent-details-review.json";
import { must } from "../helpers.js";

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

vi.mock("../../src/orchestrator.js", () => ({
	loadPhaseResources: vi
		.fn()
		.mockReturnValue({ agentPrompt: "# Reviewer", protocol: "# Protocol" }),
	loadAgentResource: vi.fn(() => "---\nname: tff-security-auditor\n---\nSecurity lens body\n"),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
	determineNextPhase: vi.fn(),
	PHASE_TOOLS: { review: [] },
}));

import { reviewPhase } from "../../src/phases/review.js";

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
const REVIEW_REL = `${SLICE_DIR}/REVIEW.md`;

async function createFullCtx(): Promise<FullCtx> {
	const db = openDatabase(":memory:");
	applyMigrations(db);

	const root = mkdtempSync(join(tmpdir(), "tff-review-int-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-review-int-wt-"));
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

	writeArtifact(root, `${SLICE_DIR}/SPEC.md`, "# Spec\nAC-1: thing works");
	writeArtifact(root, `${SLICE_DIR}/PLAN.md`, "# Plan\n- T01: task");
	writeArtifact(root, `${SLICE_DIR}/VERIFICATION.md`, "# Verified");

	// Seed closed tasks so the denied branch resets them.
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

describe("review phase → subagent → finalizer (end-to-end)", () => {
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

	it("approved: REVIEW.md(VERDICT:approved) → phase_complete + write-review + phase_run completed", async () => {
		ctx = await createFullCtx();
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"## Summary\nLGTM.\n\nVERDICT: approved",
			"utf-8",
		);

		await reviewPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, fixture, ctx.root);

		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(true);
		expect(ctx.emitted.some((e) => e.type === "phase_failed")).toBe(false);

		const run = ctx.db
			.prepare("SELECT status FROM phase_run WHERE slice_id = ? AND phase = ?")
			.get(ctx.sliceId, "review") as { status: string } | undefined;
		expect(run?.status).toBe("completed");

		const events = readEvents(ctx.root);
		expect(
			events.some(
				(e) =>
					e.cmd === "write-review" && (e.params as { sliceId?: string }).sliceId === ctx.sliceId,
			),
		).toBe(true);
		expect(artifactExists(ctx.root, REVIEW_REL)).toBe(true);
	});

	it("denied: REVIEW.md(VERDICT:denied) → phase_failed + review-rejected + slice=executing + tasks=open", async () => {
		ctx = await createFullCtx();
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"## Summary\nCritical issue.\n\n## Tasks to rework\n- T01\n\nVERDICT: denied",
			"utf-8",
		);

		await reviewPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, fixture, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("Review verdict: denied");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);

		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "review-rejected")).toBe(true);
		expect(events.some((e) => e.cmd === "write-review")).toBe(false);

		const sliceRow = ctx.db.prepare("SELECT status FROM slice WHERE id = ?").get(ctx.sliceId) as {
			status: string;
		};
		expect(sliceRow.status).toBe("executing");

		const tasks = getTasks(ctx.db, ctx.sliceId);
		expect(tasks.length).toBeGreaterThan(0);
		for (const t of tasks) expect(t.status).toBe("open");

		expect(artifactExists(ctx.root, REVIEW_REL)).toBe(true);
	});

	it("BLOCKED: STATUS:BLOCKED → phase_failed with evidence; no copy; no commit", async () => {
		ctx = await createFullCtx();
		// Pre-write REVIEW.md in worktree to prove BLOCKED branch does NOT copy it.
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"should not be copied\n\nVERDICT: approved",
			"utf-8",
		);

		const blocked = cloneFixture();
		const r0 = blocked.details.results[0];
		if (!r0) throw new Error("fixture missing result[0]");
		r0.finalOutput = "STATUS: BLOCKED\nEVIDENCE: reviewer process crashed";
		const lastAssistant = r0.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && m.content[0]?.type === "text",
		);
		if (lastAssistant && Array.isArray(lastAssistant.content)) {
			for (const part of lastAssistant.content) {
				if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
					(part as { text: string }).text = "STATUS: BLOCKED\nEVIDENCE: reviewer process crashed";
				}
			}
		}

		await reviewPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, blocked, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(String(failed?.error)).toContain("reviewer process crashed");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);

		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "write-review" || e.cmd === "review-rejected")).toBe(false);
		expect(artifactExists(ctx.root, REVIEW_REL)).toBe(false);
	});

	it("missing REVIEW.md: no pre-write → phase_failed('missing REVIEW.md')", async () => {
		ctx = await createFullCtx();
		// Deliberately no pre-write of REVIEW.md in the worktree.
		await reviewPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, fixture, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("missing REVIEW.md");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);
	});

	it("malformed VERDICT: REVIEW.md without VERDICT line → phase_failed", async () => {
		ctx = await createFullCtx();
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"## Summary\nNo trailer line.",
			"utf-8",
		);
		await reviewPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, fixture, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(String(failed?.error)).toContain("missing or malformed VERDICT");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);
	});

	it("reviewer modified tracked file → phase_failed before artifact read + no write-review", async () => {
		ctx = await createFullCtx();
		writeFileSync(
			join(ctx.worktreePath, ".pi", ".tff", "artifacts", "REVIEW.md"),
			"## Summary\nFine.\n\nVERDICT: approved",
			"utf-8",
		);

		mockedGitDirty.mockReturnValueOnce([" M src/phases/review.ts"]);

		await reviewPhase.prepare(ctx.phaseCtx);
		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, fixture, ctx.root);

		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(failed).toBeDefined();
		expect(String(failed?.error)).toContain("reviewer modified tracked files");
		expect(String(failed?.error)).toContain("src/phases/review.ts");

		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "write-review")).toBe(false);
		expect(artifactExists(ctx.root, REVIEW_REL)).toBe(false);

		mockedGitDirty.mockReturnValue([]);
	});
});
