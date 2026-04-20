import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentResult,
	type DispatchBatch,
	type DispatchResult,
	prepareDispatch,
	readDispatchResult,
	registerDispatchHook,
} from "../../../src/common/subagent-dispatcher.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makePi() {
	const handlers: Record<string, Handler[]> = {};
	return {
		handlers,
		on: (evt: string, h: Handler) => {
			const list = handlers[evt] ?? [];
			list.push(h);
			handlers[evt] = list;
		},
	};
}

function fireHook(pi: ReturnType<typeof makePi>, event: unknown, ctx: unknown): Promise<unknown> {
	const list = pi.handlers.tool_result ?? [];
	const handler = list[0];
	if (!handler) throw new Error("no tool_result handler registered");
	return Promise.resolve(handler(event, ctx));
}

function resultPathFor(r: string): string {
	return join(r, ".pi", ".tff", "dispatch-result.json");
}

function readResult(r: string): DispatchResult {
	return JSON.parse(readFileSync(resultPathFor(r), "utf-8")) as DispatchResult;
}

let root: string;
beforeEach(() => {
	root = join(tmpdir(), `tff-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
});
afterEach(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {}
});

describe("prepareDispatch", () => {
	it("writes dispatch-config.json and returns a deterministic dispatcher prompt", () => {
		const batch: DispatchBatch = {
			mode: "single",
			tasks: [{ agent: "tff-executor", task: "T", cwd: root, taskId: "T01" }],
		};
		const { message } = prepareDispatch(root, batch);
		const configPath = join(root, ".pi", ".tff", "dispatch-config.json");
		expect(existsSync(configPath)).toBe(true);
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(persisted.mode).toBe("single");
		expect(persisted.tasks).toHaveLength(1);
		expect(persisted.tasks[0].task).toBe("## Task\nT");
		expect(persisted.tasks[0].taskId).toBe("T01");
		for (const token of ["<DISPATCH-ONLY>", "subagent", "DISPATCH_COMPLETE"]) {
			expect(message).toContain(token);
		}
	});

	it("composes task body with artifacts in document order", () => {
		const batch: DispatchBatch = {
			mode: "single",
			tasks: [
				{
					agent: "tff-verifier",
					task: "T",
					cwd: root,
					artifacts: [
						{ label: "L1", content: "C1" },
						{ label: "L2", content: "C2" },
					],
				},
			],
		};
		prepareDispatch(root, batch);
		const persisted = JSON.parse(
			readFileSync(join(root, ".pi", ".tff", "dispatch-config.json"), "utf-8"),
		);
		expect(persisted.tasks[0].task).toBe("## L1\nC1\n\n## L2\nC2\n\n## Task\nT");
	});

	it("deletes stale dispatch-result.json before writing new config", () => {
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		const stalePath = join(root, ".pi", ".tff", "dispatch-result.json");
		writeFileSync(stalePath, '{"stale":true}', "utf-8");
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "tff-verifier", task: "t", cwd: root }],
		});
		expect(existsSync(stalePath)).toBe(false);
	});
});

describe("registerDispatchHook — single mode", () => {
	it("registers exactly one tool_result handler", () => {
		const pi = makePi();
		registerDispatchHook(pi as never);
		expect(pi.handlers.tool_result ?? []).toHaveLength(1);
	});

	it("no-ops when toolName !== 'subagent' OR dispatch-config.json absent", async () => {
		const pi = makePi();
		registerDispatchHook(pi as never);
		const ctx = { projectRoot: root };
		await fireHook(pi, { toolName: "bash", details: {} }, ctx);
		expect(existsSync(resultPathFor(root))).toBe(false);
		await fireHook(pi, { toolName: "subagent", details: { mode: "single", results: [] } }, ctx);
		expect(existsSync(resultPathFor(root))).toBe(false);
	});

	it("writes dispatch-result.json for single-mode happy path", async () => {
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "tff-executor", task: "t", cwd: root, taskId: "T01" }],
		});
		const pi = makePi();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [
						{
							exitCode: 0,
							finalOutput: "progress\nSTATUS: DONE\nEVIDENCE: smoke OK\n",
						},
					],
				},
			},
			{ projectRoot: root },
		);
		expect(existsSync(resultPathFor(root))).toBe(true);
		const parsed = readResult(root);
		expect(parsed.mode).toBe("single");
		expect(parsed.results).toHaveLength(1);
		const first = parsed.results[0];
		expect(first).toMatchObject<Partial<AgentResult>>({
			status: "DONE",
			evidence: "smoke OK",
			taskId: "T01",
			exitCode: 0,
		});
		expect(first?.summary).toContain("progress");
		expect(typeof parsed.capturedAt).toBe("string");
	});
});

describe("registerDispatchHook — parallel mode", () => {
	it("captures per-task results with positional taskId correspondence", async () => {
		prepareDispatch(root, {
			mode: "parallel",
			concurrency: 2,
			tasks: [
				{ agent: "tff-executor", task: "t1", cwd: root, taskId: "T01" },
				{ agent: "tff-executor", task: "t2", cwd: root, taskId: "T02" },
			],
		});
		const pi = makePi();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "parallel",
					results: [
						{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: a" },
						{ exitCode: 0, finalOutput: "STATUS: DONE_WITH_CONCERNS\nEVIDENCE: b" },
					],
				},
			},
			{ projectRoot: root },
		);
		const parsed = readResult(root);
		expect(parsed.mode).toBe("parallel");
		expect(parsed.results.map((r) => r.taskId)).toEqual(["T01", "T02"]);
		expect(parsed.results.map((r) => r.status)).toEqual(["DONE", "DONE_WITH_CONCERNS"]);
		expect(parsed.results.map((r) => r.evidence)).toEqual(["a", "b"]);
	});
});

describe("registerDispatchHook — BLOCKED paths", () => {
	async function fire(event: unknown): Promise<DispatchResult> {
		const pi = makePi();
		registerDispatchHook(pi as never);
		await fireHook(pi, event, { projectRoot: root });
		return readResult(root);
	}

	it("missing STATUS line → BLOCKED, evidence 'malformed output'", async () => {
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "x", task: "t", cwd: root }],
		});
		const parsed = await fire({
			toolName: "subagent",
			details: {
				mode: "single",
				results: [{ exitCode: 0, finalOutput: "no status here" }],
			},
		});
		expect(parsed.results[0]?.status).toBe("BLOCKED");
		expect(parsed.results[0]?.evidence).toBe("malformed output");
	});

	it("non-zero exitCode → BLOCKED with error message", async () => {
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "x", task: "t", cwd: root }],
		});
		const parsed = await fire({
			toolName: "subagent",
			details: { mode: "single", results: [{ exitCode: 1, error: "boom" }] },
		});
		expect(parsed.results[0]?.status).toBe("BLOCKED");
		expect(parsed.results[0]?.evidence).toBe("boom");
		expect(parsed.results[0]?.exitCode).toBe(1);
		expect(parsed.results[0]?.error).toBe("boom");
	});

	it("non-zero exitCode without error → BLOCKED, evidence 'non-zero exit'", async () => {
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "x", task: "t", cwd: root }],
		});
		const parsed = await fire({
			toolName: "subagent",
			details: { mode: "single", results: [{ exitCode: 1 }] },
		});
		expect(parsed.results[0]?.evidence).toBe("non-zero exit");
	});

	it("empty single results → BLOCKED, evidence 'missing single result'", async () => {
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "x", task: "t", cwd: root }],
		});
		const parsed = await fire({
			toolName: "subagent",
			details: { mode: "single", results: [] },
		});
		expect(parsed.results[0]?.evidence).toBe("missing single result");
	});

	it("parallel length mismatch → all BLOCKED with 'missing parallel result'", async () => {
		prepareDispatch(root, {
			mode: "parallel",
			tasks: [
				{ agent: "x", task: "t1", cwd: root, taskId: "T01" },
				{ agent: "x", task: "t2", cwd: root, taskId: "T02" },
			],
		});
		const parsed = await fire({
			toolName: "subagent",
			details: {
				mode: "parallel",
				results: [{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: a" }],
			},
		});
		expect(parsed.results).toHaveLength(2);
		for (const r of parsed.results) {
			expect(r.status).toBe("BLOCKED");
			expect(r.evidence).toBe("missing parallel result");
		}
	});
});

describe("registerDispatchHook — idempotency", () => {
	it("second call with same pi instance does not register a second listener", () => {
		const pi = makePi();
		registerDispatchHook(pi as never);
		registerDispatchHook(pi as never);
		expect(pi.handlers.tool_result).toHaveLength(1);
	});
});

describe("readDispatchResult", () => {
	it("returns null when file absent", () => {
		expect(readDispatchResult(root)).toBeNull();
	});

	it("returns parsed result and deletes the file (consume-once)", async () => {
		prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "x", task: "t", cwd: root }],
		});
		const pi = makePi();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: ok" }],
				},
			},
			{ projectRoot: root },
		);
		const first = readDispatchResult(root);
		expect(first?.results[0]?.status).toBe("DONE");
		expect(existsSync(resultPathFor(root))).toBe(false);
		expect(readDispatchResult(root)).toBeNull();
	});
});
