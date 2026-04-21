import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentResult,
	type CapturedCall,
	type DispatchBatch,
	type DispatchResult,
	type FinalizeInput,
	type Finalizer,
	MAX_OUTPUT_BYTES,
	__getFinalizerForTest,
	__resetFinalizersForTest,
	prepareDispatch,
	readDispatchResult,
	registerDispatchHook,
	registerPhaseFinalizer,
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
	__resetFinalizersForTest();
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
			phase: "execute",
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
			phase: "verify",
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
			phase: "verify",
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
			phase: "execute",
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
			phase: "execute",
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
			phase: "verify",
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
			phase: "verify",
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
			phase: "verify",
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
			phase: "verify",
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
			phase: "execute",
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
			phase: "verify",
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

describe("phase + sliceId persistence", () => {
	it("persists phase and sliceId in dispatch-config.json", () => {
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "slice-abc",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const cfg = JSON.parse(
			readFileSync(join(root, ".pi", ".tff", "dispatch-config.json"), "utf-8"),
		);
		expect(cfg.phase).toBe("verify");
		expect(cfg.sliceId).toBe("slice-abc");
	});

	it("persists phase without sliceId when sliceId omitted", () => {
		prepareDispatch(root, {
			mode: "single",
			phase: "execute",
			tasks: [{ agent: "tff-executor", task: "x", cwd: "/tmp" }],
		});
		const cfg = JSON.parse(
			readFileSync(join(root, ".pi", ".tff", "dispatch-config.json"), "utf-8"),
		);
		expect(cfg.phase).toBe("execute");
		expect(cfg.sliceId).toBeUndefined();
	});
});

describe("registerPhaseFinalizer", () => {
	it("replaces with last-wins semantics", () => {
		const first: Finalizer = async () => {};
		const second: Finalizer = async () => {};
		registerPhaseFinalizer("verify", first);
		registerPhaseFinalizer("verify", second);
		expect(__getFinalizerForTest("verify")).toBe(second);
	});

	it("__resetFinalizersForTest clears all registrations", () => {
		const fn: Finalizer = async () => {};
		registerPhaseFinalizer("verify", fn);
		expect(__getFinalizerForTest("verify")).toBe(fn);
		__resetFinalizersForTest();
		expect(__getFinalizerForTest("verify")).toBeUndefined();
	});

	it("FinalizeInput type compiles with {root, result, calls} only", () => {
		// Structural: TS compile is the assertion. Do not list db/pi/slice fields.
		const fn: Finalizer = async ({ root, result, calls }) => {
			void root;
			void result;
			void calls;
		};
		expect(fn).toBeDefined();
	});
});

describe("tool_result hook — capture + finalizer", () => {
	function makePiWithEvents() {
		const handlers: Record<string, Handler[]> = {};
		const listeners: Record<string, Array<(e: unknown) => void>> = {};
		return {
			handlers,
			on: (evt: string, h: Handler) => {
				const list = handlers[evt] ?? [];
				list.push(h);
				handlers[evt] = list;
			},
			events: {
				on: (channel: string, l: (e: unknown) => void) => {
					const list = listeners[channel] ?? [];
					list.push(l);
					listeners[channel] = list;
				},
				emit: (channel: string, payload: unknown) => {
					for (const l of listeners[channel] ?? []) l(payload);
				},
			},
			listeners,
		};
	}

	function bashCall(id: string, command: string) {
		return {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		};
	}
	function bashResult(id: string, isError: boolean, text: string, ts: number) {
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError,
			timestamp: ts,
		};
	}
	function doneFinalOutput() {
		return "STATUS: DONE\nEVIDENCE: ok";
	}

	it("extracts bash tool calls in message order with toolCallId pairing", async () => {
		const captured: CapturedCall[][] = [];
		registerPhaseFinalizer("verify", async ({ calls }) => {
			captured.push(calls);
		});
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
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
							finalOutput: doneFinalOutput(),
							messages: [
								bashCall("call_1", "bun test"),
								bashResult("call_1", false, "pass", 1),
								{
									role: "assistant",
									content: [
										{
											type: "toolCall",
											id: "call_2",
											name: "write",
											arguments: { path: "x", content: "y" },
										},
									],
								},
								{
									role: "toolResult",
									toolCallId: "call_2",
									toolName: "write",
									content: [{ type: "text", text: "ok" }],
									isError: false,
									timestamp: 2,
								},
								bashCall("call_3", "bun lint"),
								bashResult("call_3", true, "fail", 3),
							],
						},
					],
				},
			},
			{ projectRoot: root },
		);
		expect(captured).toHaveLength(1);
		const calls = captured[0] ?? [];
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			toolName: "bash",
			toolCallId: "call_1",
			input: { command: "bun test" },
			isError: false,
			outputText: "pass",
			timestamp: 1,
		});
		expect(calls[1]).toMatchObject({
			toolName: "bash",
			toolCallId: "call_3",
			input: { command: "bun lint" },
			isError: true,
			outputText: "fail",
			timestamp: 3,
		});
	});

	it("skips finalization when no finalizer is registered; no phase_complete emitted", async () => {
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
		const emitted: unknown[] = [];
		pi.events.on("tff:phase", (e) => emitted.push(e));
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [{ exitCode: 0, finalOutput: doneFinalOutput(), messages: [] }],
				},
			},
			{ projectRoot: root },
		);
		// No finalizer → hook falls through to S02-style behavior: result file
		// remains for readDispatchResult consume-once, no phase event emitted.
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(true);
		expect(emitted).toHaveLength(0);
	});

	it("invokes finalizer exactly once with {root, result, calls}", async () => {
		const inputs: FinalizeInput[] = [];
		registerPhaseFinalizer("verify", async (input) => {
			inputs.push(input);
		});
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [{ exitCode: 0, finalOutput: doneFinalOutput(), messages: [] }],
				},
			},
			{ projectRoot: root },
		);
		expect(inputs).toHaveLength(1);
		const first = inputs[0];
		expect(first?.root).toBe(root);
		expect(first?.result.mode).toBe("single");
		expect(Array.isArray(first?.calls)).toBe(true);
	});

	it("finalizer throw → hook emits phase_failed with sliceId from config and err.message", async () => {
		registerPhaseFinalizer("verify", async () => {
			throw new Error("boom");
		});
		const emitted: unknown[] = [];
		const pi = makePiWithEvents();
		pi.events.on("tff:phase", (e: unknown) => emitted.push(e));
		registerDispatchHook(pi as never);
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "slice-abc",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [{ exitCode: 0, finalOutput: doneFinalOutput(), messages: [] }],
				},
			},
			{ projectRoot: root },
		);
		const failed = emitted.find(
			(e) =>
				typeof e === "object" && e !== null && (e as { type?: unknown }).type === "phase_failed",
		);
		expect(failed).toMatchObject({
			type: "phase_failed",
			phase: "verify",
			sliceId: "slice-abc",
			error: "boom",
		});
	});

	it("deletes dispatch-config.json AND dispatch-result.json after finalizer returns", async () => {
		registerPhaseFinalizer("verify", async () => {});
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [{ exitCode: 0, finalOutput: doneFinalOutput(), messages: [] }],
				},
			},
			{ projectRoot: root },
		);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
	});

	it("deletes dispatch files even when finalizer throws", async () => {
		registerPhaseFinalizer("verify", async () => {
			throw new Error("boom");
		});
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [{ exitCode: 0, finalOutput: doneFinalOutput(), messages: [] }],
				},
			},
			{ projectRoot: root },
		);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
	});

	it("pairs calls with nearest-by-id toolResult and concatenates multiple text parts", async () => {
		const captured: CapturedCall[][] = [];
		registerPhaseFinalizer("verify", async ({ calls }) => {
			captured.push(calls);
		});
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
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
							finalOutput: doneFinalOutput(),
							messages: [
								bashCall("call_a", "echo hi"),
								{
									role: "toolResult",
									toolCallId: "call_a",
									toolName: "bash",
									content: [
										{ type: "text", text: "part1 " },
										{ type: "text", text: "part2" },
									],
									isError: false,
									timestamp: 5,
								},
							],
						},
					],
				},
			},
			{ projectRoot: root },
		);
		const capturedCalls = captured[0] ?? [];
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.outputText).toBe("part1 part2");
	});

	it("Fix-2: outputText >100 KB is truncated to <70 000 chars and ends with [truncated: N bytes]", async () => {
		const captured: CapturedCall[][] = [];
		registerPhaseFinalizer("verify", async ({ calls }) => {
			captured.push(calls);
		});
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			sliceId: "s1",
			tasks: [{ agent: "tff-verifier", task: "x", cwd: "/tmp" }],
		});
		const pi = makePiWithEvents();
		registerDispatchHook(pi as never);

		// Produce a synthetic output that is well above MAX_OUTPUT_BYTES (65 536).
		const bigText = "x".repeat(110_000);
		const originalByteLength = Buffer.byteLength(bigText, "utf8");

		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "single",
					results: [
						{
							exitCode: 0,
							finalOutput: "STATUS: DONE\nEVIDENCE: ok",
							messages: [
								{
									role: "assistant",
									content: [
										{
											type: "toolCall",
											id: "big_call",
											name: "bash",
											arguments: { command: "cat big-file" },
										},
									],
								},
								{
									role: "toolResult",
									toolCallId: "big_call",
									toolName: "bash",
									content: [{ type: "text", text: bigText }],
									isError: false,
									timestamp: 1,
								},
							],
						},
					],
				},
			},
			{ projectRoot: root },
		);

		const calls = captured[0] ?? [];
		expect(calls).toHaveLength(1);
		const outputText = calls[0]?.outputText ?? "";
		expect(outputText.length).toBeLessThan(70_000);
		expect(outputText).toContain(`[truncated: ${originalByteLength} bytes]`);
		// MAX_OUTPUT_BYTES is respected as the byte cap
		expect(MAX_OUTPUT_BYTES).toBe(65536);
	});
});

function makePiWithEventsT01() {
	const handlers: Record<string, Handler[]> = {};
	const listeners: Record<string, Array<(e: unknown) => void>> = {};
	const emittedPhase: Array<{ type: string; error?: string; [k: string]: unknown }> = [];
	const api = {
		handlers,
		on: (evt: string, h: Handler) => {
			const list = handlers[evt] ?? [];
			list.push(h);
			handlers[evt] = list;
		},
		events: {
			on: (channel: string, l: (e: unknown) => void) => {
				const list = listeners[channel] ?? [];
				list.push(l);
				listeners[channel] = list;
			},
			emit: (channel: string, payload: unknown) => {
				if (channel === "tff:phase" && payload && typeof payload === "object") {
					emittedPhase.push(payload as { type: string });
				}
				for (const l of listeners[channel] ?? []) l(payload);
			},
		},
		listeners,
		emittedPhase,
	};
	return api;
}

describe("DISPATCHER_PROMPT — multi-wave loop clause (AC-11)", () => {
	it("instructs the dispatcher to re-read dispatch-config.json after each subagent call", () => {
		const { message } = prepareDispatch(root, {
			mode: "parallel",
			phase: "execute",
			tasks: [{ agent: "tff-executor", task: "t", cwd: root }],
		});
		expect(message).toMatch(/re-read .*dispatch-config\.json/i);
		expect(message).toMatch(/DISPATCH_COMPLETE/);
		expect(message).toMatch(/make ANOTHER subagent call|if the file exists/i);
	});
});

describe("Finalizer return type compatibility (AC-12)", () => {
	it("accepts Promise<void> return (S03/S04 finalizers remain valid)", () => {
		const fn: Finalizer = async () => {};
		registerPhaseFinalizer("verify", fn);
		expect(__getFinalizerForTest("verify")).toBe(fn);
	});
	it("accepts Promise<FinalizeOutcome> return (S05 finalizers)", () => {
		const fn: Finalizer = async () => ({ continue: true });
		registerPhaseFinalizer("execute", fn);
		expect(__getFinalizerForTest("execute")).toBe(fn);
	});
});

describe("tool_result hook — cleanup signalling (AC-13, AC-14, AC-15)", () => {
	it("AC-13: when finalizer returns {continue:true}, dispatch-config.json is preserved, dispatch-result.json is deleted", async () => {
		prepareDispatch(root, {
			mode: "parallel",
			phase: "execute",
			tasks: [{ agent: "tff-executor", task: "t", cwd: root, taskId: "T01" }],
		});
		registerPhaseFinalizer("execute", async () => ({ continue: true }));
		const pi = makePi();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "parallel",
					results: [{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: a" }],
				},
			},
			{ projectRoot: root },
		);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(true);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
	});

	it("AC-14: when finalizer returns undefined (void), both files are deleted", async () => {
		prepareDispatch(root, {
			mode: "single",
			phase: "verify",
			tasks: [{ agent: "x", task: "t", cwd: root }],
		});
		registerPhaseFinalizer("verify", async () => {});
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
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
	});

	it("AC-14: when finalizer returns {continue:false}, both files are deleted", async () => {
		prepareDispatch(root, {
			mode: "parallel",
			phase: "execute",
			tasks: [{ agent: "x", task: "t", cwd: root, taskId: "T01" }],
		});
		registerPhaseFinalizer("execute", async () => ({ continue: false }));
		const pi = makePi();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "parallel",
					results: [{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: a" }],
				},
			},
			{ projectRoot: root },
		);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
	});

	it("AC-15: when finalizer throws, both files are deleted and phase_failed is emitted", async () => {
		prepareDispatch(root, {
			mode: "parallel",
			phase: "execute",
			tasks: [{ agent: "x", task: "t", cwd: root, taskId: "T01" }],
		});
		registerPhaseFinalizer("execute", async () => {
			throw new Error("boom");
		});
		const pi = makePiWithEventsT01();
		registerDispatchHook(pi as never);
		await fireHook(
			pi,
			{
				toolName: "subagent",
				details: {
					mode: "parallel",
					results: [{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: a" }],
				},
			},
			{ projectRoot: root },
		);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(false);
		const failed = pi.emittedPhase.find((e) => e.type === "phase_failed");
		expect(failed?.error).toBe("boom");
	});
});

describe("parseAgentResults — positional ordering for parallel mode (AC-34)", () => {
	it("3-task parallel batch preserves config->result taskId correspondence", async () => {
		prepareDispatch(root, {
			mode: "parallel",
			phase: "execute",
			tasks: [
				{ agent: "tff-executor", task: "t1", cwd: root, taskId: "T01" },
				{ agent: "tff-executor", task: "t2", cwd: root, taskId: "T02" },
				{ agent: "tff-executor", task: "t3", cwd: root, taskId: "T03" },
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
						{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: e1" },
						{ exitCode: 0, finalOutput: "STATUS: DONE_WITH_CONCERNS\nEVIDENCE: e2" },
						{ exitCode: 0, finalOutput: "STATUS: DONE\nEVIDENCE: e3" },
					],
				},
			},
			{ projectRoot: root },
		);
		const parsed = readResult(root);
		expect(parsed.results.map((r) => r.taskId)).toEqual(["T01", "T02", "T03"]);
		expect(parsed.results.map((r) => r.evidence)).toEqual(["e1", "e2", "e3"]);
	});
});

describe("tool_result hook — config cleanup when no finalizer is registered", () => {
	it("deletes dispatch-config.json but preserves dispatch-result.json so DISPATCHER_PROMPT loop terminates for non-migrated phases", async () => {
		prepareDispatch(root, {
			mode: "single",
			phase: "execute",
			tasks: [{ agent: "tff-noop", task: "t", cwd: root }],
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
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-config.json"))).toBe(false);
		expect(existsSync(join(root, ".pi", ".tff", "dispatch-result.json"))).toBe(true);
	});
});
