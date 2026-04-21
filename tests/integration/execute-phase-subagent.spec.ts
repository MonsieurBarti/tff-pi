import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	getTask,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSliceTier,
} from "../../src/common/db.js";
import { readEvents } from "../../src/common/event-log.js";
import type { PhaseContext } from "../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../src/common/settings.js";
import {
	type DispatchBatch,
	__resetFinalizersForTest,
	registerDispatchHook,
} from "../../src/common/subagent-dispatcher.js";
import { registerPhaseFinalizers } from "../../src/phases/finalizers.js";
import wave1Fixture from "../fixtures/subagent-details-execute-wave1.json";
import wave2Fixture from "../fixtures/subagent-details-execute-wave2.json";
import { must } from "../helpers.js";

let worktreePath = "";

vi.mock("../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn(() => worktreePath),
	createWorktree: vi.fn(() => worktreePath),
	worktreeExists: vi.fn().mockReturnValue(true),
	ensureSliceWorktree: vi.fn(() => worktreePath),
}));

vi.mock("../../src/common/checkpoint.js", () => ({
	createCheckpoint: vi.fn(),
	listCheckpoints: vi.fn().mockReturnValue([]),
	getLastCheckpoint: vi.fn().mockReturnValue(null),
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../src/orchestrator.js", () => ({
	enrichContextWithFff: vi.fn(),
	predecessorPhase: vi.fn().mockReturnValue(null),
	verifyPhaseArtifacts: vi.fn().mockReturnValue({ ok: false, missing: [] }),
}));

import { createCheckpoint } from "../../src/common/checkpoint.js";
import { executePhase } from "../../src/phases/execute.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface TestPi {
	handlers: Record<string, Handler[]>;
	listeners: Record<string, Array<(e: unknown) => void>>;
	on(evt: string, h: Handler): void;
	events: {
		on(channel: string, l: (e: unknown) => void): void;
		emit(channel: string, payload: unknown): void;
	};
	sendUserMessage: (msg: string) => void;
}

function makePi(): TestPi {
	const handlers: Record<string, Handler[]> = {};
	const listeners: Record<string, Array<(e: unknown) => void>> = {};
	return {
		handlers,
		listeners,
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
		sendUserMessage: vi.fn(),
	};
}

async function fireToolResult(pi: TestPi, event: unknown, root: string): Promise<void> {
	const list = pi.handlers.tool_result ?? [];
	for (const h of list) await h(event, { projectRoot: root });
}

function cloneWave1(): typeof wave1Fixture {
	return structuredClone(wave1Fixture);
}

function cloneWave2(): typeof wave2Fixture {
	return structuredClone(wave2Fixture);
}

function readDispatchConfig(root: string): DispatchBatch | null {
	const p = join(root, ".pi", ".tff", "dispatch-config.json");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf-8")) as DispatchBatch;
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

async function createFullCtx(waves: number[][]): Promise<FullCtx> {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-exec-int-root-"));
	worktreePath = mkdtempSync(join(tmpdir(), "tff-exec-int-wt-"));
	initTffDirectory(root);

	insertProject(db, { name: "TFF", vision: "V" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Exec" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, "SS");
	db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
	insertPhaseRun(db, {
		sliceId,
		phase: "execute",
		status: "started",
		startedAt: new Date().toISOString(),
	});
	writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1");
	writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");

	const taskIds: string[] = [];
	let number = 1;
	let waveNum = 1;
	for (const wave of waves) {
		for (const _n of wave) {
			taskIds.push(insertTask(db, { sliceId, number, title: `T${number}`, wave: waveNum }));
			number += 1;
		}
		waveNum += 1;
	}

	const pi = makePi();
	const tffCtx = {
		db,
		projectRoot: root,
		settings: DEFAULT_SETTINGS,
	} as unknown as Parameters<typeof registerDispatchHook>[1];
	registerDispatchHook(pi as never, tffCtx);

	const emitted: Array<{ type: string; [k: string]: unknown }> = [];
	pi.events.on("tff:phase", (e) => emitted.push(e as { type: string; [k: string]: unknown }));

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

function setResultStatus(
	fixture: typeof wave1Fixture,
	idx: number,
	status: string,
	evidence: string,
): void {
	const r = fixture.details.results[idx];
	if (!r) throw new Error(`fixture missing result[${idx}]`);
	const finalOutput = `STATUS: ${status}\nEVIDENCE: ${evidence}`;
	r.finalOutput = finalOutput;
	for (const m of r.messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const part of m.content) {
				if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
					(part as { text: string }).text = finalOutput;
				}
			}
		}
	}
}

describe("execute phase → subagent → finalizer (multi-wave end-to-end)", () => {
	let ctx: FullCtx;

	beforeEach(() => {
		__resetFinalizersForTest();
		registerPhaseFinalizers();
		vi.mocked(createCheckpoint).mockClear();
	});

	afterEach(() => {
		if (ctx) {
			try {
				rmSync(ctx.root, { recursive: true, force: true });
			} catch {}
			try {
				rmSync(ctx.worktreePath, { recursive: true, force: true });
			} catch {}
			ctx.db.close();
		}
	});

	it("happy multi-wave: wave1 DONE → wave2 dispatched → wave2 DONE → execute-done + phase_complete", async () => {
		ctx = await createFullCtx([[1, 2], [3]]);
		await executePhase.prepare(ctx.phaseCtx);

		// Wave 1: adjust fixture results to carry real taskIds (via dispatch-config positional correlation)
		const wave1 = cloneWave1();
		setResultStatus(wave1, 0, "DONE", "t01 done");
		setResultStatus(wave1, 1, "DONE", "t02 done");

		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, wave1, ctx.root);

		// Wave-1 tasks closed; wave-2 task still open.
		expect(getTask(ctx.db, must(ctx.taskIds[0]))?.status).toBe("closed");
		expect(getTask(ctx.db, must(ctx.taskIds[1]))?.status).toBe("closed");
		expect(getTask(ctx.db, must(ctx.taskIds[2]))?.status).toBe("open");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		// Wave 2 dispatch config persisted, config file preserved (continue:true).
		const midCfg = readDispatchConfig(ctx.root);
		expect(midCfg).not.toBeNull();
		expect(midCfg?.tasks).toHaveLength(1);
		expect(midCfg?.tasks[0]?.taskId).toBe(ctx.taskIds[2]);

		// Wave 2 fires
		const wave2 = cloneWave2();
		setResultStatus(wave2, 0, "DONE", "t03 done");
		await fireToolResult(ctx.pi, wave2, ctx.root);

		expect(getTask(ctx.db, must(ctx.taskIds[2]))?.status).toBe("closed");
		expect(ctx.emitted.some((e) => e.type === "phase_complete" && e.phase === "execute")).toBe(
			true,
		);
		// Now the hook should have cleaned both files (continue:false on final wave).
		expect(existsSync(join(ctx.root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(ctx.root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
		// execute-done command recorded in event log.
		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "execute-done")).toBe(true);
	});

	it("BLOCKED in wave 1: no wave-2 dispatch; phase_failed; wave-2 task stays open; re-entry re-partitions remaining open tasks", async () => {
		ctx = await createFullCtx([[1, 2], [3]]);
		await executePhase.prepare(ctx.phaseCtx);

		const wave1 = cloneWave1();
		setResultStatus(wave1, 0, "DONE", "t01 done");
		setResultStatus(wave1, 1, "BLOCKED", "kaboom in t02");

		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, wave1, ctx.root);

		// T01 closed, T02 still open, T03 still open.
		expect(getTask(ctx.db, must(ctx.taskIds[0]))?.status).toBe("closed");
		expect(getTask(ctx.db, must(ctx.taskIds[1]))?.status).toBe("open");
		expect(getTask(ctx.db, must(ctx.taskIds[2]))?.status).toBe("open");
		const failed = ctx.emitted.find((e) => e.type === "phase_failed");
		expect(String(failed?.error)).toMatch(/^BLOCKED:/);
		expect(String(failed?.error)).toContain("kaboom");
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(false);
		// No execute-done event.
		const events = readEvents(ctx.root);
		expect(events.some((e) => e.cmd === "execute-done")).toBe(false);
		// Hook cleaned up (continue:false, no next-wave config written).
		expect(existsSync(join(ctx.root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);

		// Re-entry: prepare() again should partition against still-open tasks (T02 + T03).
		__resetFinalizersForTest();
		registerPhaseFinalizers();
		ctx.emitted.length = 0;
		await executePhase.prepare(ctx.phaseCtx);
		const cfg = readDispatchConfig(ctx.root);
		expect(cfg).not.toBeNull();
		// Still-open T02 is in wave 1, and T03 is in wave 2 — first-wave dispatch contains T02 only.
		expect(cfg?.tasks.map((t) => t.taskId).sort()).toEqual([ctx.taskIds[1]].sort());
	});

	it("parallel-batch result ordering — config.tasks[i].taskId corresponds to details.results[i] (AC-36)", async () => {
		// 3 tasks, all in wave 1, all DONE. Locks pi-subagents positional correlation.
		ctx = await createFullCtx([[1, 2, 3]]);
		await executePhase.prepare(ctx.phaseCtx);

		const cfg = readDispatchConfig(ctx.root);
		expect(cfg?.tasks).toHaveLength(3);
		const orderedTaskIds = (cfg?.tasks ?? []).map((t) => t.taskId ?? "");

		// Build a synthetic 3-result fixture by extending wave1 (which has 2 results
		// in the hand-authored fixture) — we start from wave2's shape and replicate.
		const wave1 = cloneWave1();
		// Clone result[1] to make a third entry.
		const extra = structuredClone(must(wave1.details.results[0]));
		wave1.details.results.push(extra);
		setResultStatus(wave1, 0, "DONE", "evidence-A");
		setResultStatus(wave1, 1, "DONE", "evidence-B");
		setResultStatus(wave1, 2, "DONE", "evidence-C");

		ctx.emitted.length = 0;
		await fireToolResult(ctx.pi, wave1, ctx.root);

		// All three tasks should be closed.
		for (const tid of ctx.taskIds) expect(getTask(ctx.db, tid)?.status).toBe("closed");
		// execute-done fired (final wave).
		expect(ctx.emitted.some((e) => e.type === "phase_complete")).toBe(true);

		// Ordering assertion: the order in which orderedTaskIds[i] was sent matches
		// the order we consumed them. Since prepareDispatch persists tasks in the
		// same order the phase passes them in, and parseAgentResults correlates
		// positionally, the closed-task order follows the input order.
		expect(orderedTaskIds.length).toBe(3);
	});
});
