import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCurrentPhase, setCurrentPhase } from "../../../src/common/current-phase-context.js";
import { applyMigrations } from "../../../src/common/db.js";
import { EventLogger } from "../../../src/common/event-logger.js";
import type { EventBus } from "../../../src/common/events.js";
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

describe("ToolCallLogger → EventLogger round-trip", () => {
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

	it("during a phase, a bash call lands in the DB and per-slice JSONL", () => {
		const bus = makeInProcessBus();
		const eventLogger = new EventLogger(db, tmp);
		eventLogger.subscribe(bus);

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

		const row = db
			.prepare("SELECT channel, type, slice_id, payload FROM event_log WHERE channel = 'tff:tool'")
			.get() as { channel: string; type: string; slice_id: string; payload: string };
		expect(row.channel).toBe("tff:tool");
		expect(row.slice_id).toBe("slice-xyz");
		const payload = JSON.parse(row.payload);
		expect(payload.toolName).toBe("bash");
		expect(payload.output).toBe("a.ts\nb.ts");
		expect(payload.durationMs).toBe(25);

		const files = readdirSync(tmp);
		expect(files).toContain("M09-S01.jsonl");
		const content = readFileSync(join(tmp, "M09-S01.jsonl"), "utf-8");
		expect(content).toContain('"toolName":"bash"');
	});

	it("outside a phase, a bash call lands in ambient.jsonl with empty DB slice_id", () => {
		const bus = makeInProcessBus();
		const eventLogger = new EventLogger(db, tmp);
		eventLogger.subscribe(bus);

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

		const row = db.prepare("SELECT slice_id FROM event_log WHERE channel = 'tff:tool'").get() as {
			slice_id: string;
		};
		expect(row.slice_id).toBe("");

		const files = readdirSync(tmp);
		expect(files).toContain("ambient.jsonl");
		expect(existsSync(join(tmp, "ambient.jsonl"))).toBe(true);
	});

	it("oversized output is truncated by the existing 64 KB policy", () => {
		const bus = makeInProcessBus();
		const eventLogger = new EventLogger(db, tmp);
		eventLogger.subscribe(bus);

		const { pi, fire } = makeFakePi();
		const toolLogger = new ToolCallLogger(pi, bus);
		toolLogger.subscribe();

		const huge = "x".repeat(128 * 1024);
		fire("tool_call", { toolCallId: "c3", toolName: "bash", input: { command: "huge" } });
		fire("tool_execution_end", {
			toolCallId: "c3",
			toolName: "bash",
			result: huge,
			isError: false,
		});

		const row = db.prepare("SELECT payload FROM event_log WHERE channel = 'tff:tool'").get() as {
			payload: string;
		};
		expect(row.payload.length).toBeLessThanOrEqual(64 * 1024);
		expect(row.payload).toContain("truncated");
	});
});
