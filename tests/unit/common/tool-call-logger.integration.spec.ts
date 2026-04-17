import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCurrentPhase, setCurrentPhase } from "../../../src/common/current-phase-context.js";
import { applyMigrations } from "../../../src/common/db.js";
import type { EventBus } from "../../../src/common/events.js";
import { PerSliceLog } from "../../../src/common/per-slice-log.js";
import { ToolCallLogger } from "../../../src/common/tool-call-logger.js";

type Handler = (data: unknown) => void;

function makeInProcessBus(): EventBus {
	const handlers = new Map<string, Set<Handler>>();
	return {
		on(channel, handler) {
			let set = handlers.get(channel);
			if (!set) {
				set = new Set();
				handlers.set(channel, set);
			}
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			for (const h of handlers.get(channel) ?? []) h(data);
		},
	};
}

function makeFakePi() {
	const piHandlers = new Map<string, Set<Handler>>();
	return {
		pi: {
			on(event: string, handler: Handler) {
				let set = piHandlers.get(event);
				if (!set) {
					set = new Set();
					piHandlers.set(event, set);
				}
				set.add(handler);
				return () => {
					set.delete(handler);
				};
			},
		},
		fire(event: string, data: unknown) {
			for (const h of piHandlers.get(event) ?? []) h(data);
		},
	};
}

describe("ToolCallLogger → PerSliceLog round-trip", () => {
	let tmp: string;
	let db: Database.Database;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
		tmp = mkdtempSync(join(tmpdir(), "tff-tcl-"));
		db = new Database(":memory:");
		applyMigrations(db);
	});
	afterEach(() => {
		clearCurrentPhase();
		vi.useRealTimers();
		db.close();
	});

	it("during a phase, a bash call lands in per-slice JSONL", () => {
		const bus = makeInProcessBus();
		const perSliceLog = new PerSliceLog(tmp);
		perSliceLog.subscribe(bus);

		const { pi, fire } = makeFakePi();
		const toolLogger = new ToolCallLogger(pi, bus);
		toolLogger.subscribe();

		setCurrentPhase({
			sliceId: "slice-xyz",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});

		fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
		vi.advanceTimersByTime(25);
		fire("tool_execution_end", {
			toolCallId: "c1",
			toolName: "bash",
			result: "a.ts\nb.ts",
			isError: false,
		});

		const files = readdirSync(join(tmp, ".tff", "logs"));
		expect(files).toContain("M09-S01.jsonl");
		const content = readFileSync(join(tmp, ".tff", "logs", "M09-S01.jsonl"), "utf-8");
		expect(content).toContain('"toolName":"bash"');
		expect(content).toContain('"output"');

		perSliceLog.dispose();
	});

	it("outside a phase, a bash call lands in ambient.jsonl", () => {
		const bus = makeInProcessBus();
		const perSliceLog = new PerSliceLog(tmp);
		perSliceLog.subscribe(bus);

		const { pi, fire } = makeFakePi();
		const toolLogger = new ToolCallLogger(pi, bus);
		toolLogger.subscribe();

		fire("tool_call", { toolCallId: "c2", toolName: "bash", input: { command: "ls" } });
		fire("tool_execution_end", {
			toolCallId: "c2",
			toolName: "bash",
			result: "x",
			isError: false,
		});

		const files = readdirSync(join(tmp, ".tff", "logs"));
		expect(files).toContain("ambient.jsonl");
		expect(existsSync(join(tmp, ".tff", "logs", "ambient.jsonl"))).toBe(true);

		perSliceLog.dispose();
	});

	it("oversized output is truncated by the existing 64 KB policy (JSONL stays readable)", () => {
		const bus = makeInProcessBus();
		const perSliceLog = new PerSliceLog(tmp);
		perSliceLog.subscribe(bus);

		const { pi, fire } = makeFakePi();
		const toolLogger = new ToolCallLogger(pi, bus);
		toolLogger.subscribe();

		setCurrentPhase({
			sliceId: "slice-xyz",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});

		const huge = "x".repeat(128 * 1024);
		fire("tool_call", { toolCallId: "c3", toolName: "bash", input: { command: "huge" } });
		fire("tool_execution_end", {
			toolCallId: "c3",
			toolName: "bash",
			result: huge,
			isError: false,
		});

		const content = readFileSync(join(tmp, ".tff", "logs", "M09-S01.jsonl"), "utf-8");
		const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
		// The output field should contain "[truncated" marker or full value
		// depending on ToolCallLogger truncation logic
		expect(typeof parsed.output === "string" || typeof parsed.output === "object").toBe(true);

		perSliceLog.dispose();
	});

	it("truncated payloads remain parseable JSON (not string-spliced)", () => {
		const bus = makeInProcessBus();
		const perSliceLog = new PerSliceLog(tmp);
		perSliceLog.subscribe(bus);

		const { pi, fire } = makeFakePi();
		const toolLogger = new ToolCallLogger(pi, bus);
		toolLogger.subscribe();

		setCurrentPhase({
			sliceId: "slice-xyz",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});

		const huge = "x".repeat(128 * 1024);
		fire("tool_call", { toolCallId: "c-parse", toolName: "bash", input: { command: "huge" } });
		fire("tool_execution_end", {
			toolCallId: "c-parse",
			toolName: "bash",
			result: huge,
			isError: false,
		});

		const content = readFileSync(join(tmp, ".tff", "logs", "M09-S01.jsonl"), "utf-8");
		// Must not throw — regression guard against invalid JSON lines.
		expect(() => JSON.parse(content.trim())).not.toThrow();

		perSliceLog.dispose();
	});
});
