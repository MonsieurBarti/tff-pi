import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PerSliceLog, readPerSliceLog } from "../../../src/common/per-slice-log.js";

function makeBus() {
	const handlers: Map<string, Array<(d: unknown) => void>> = new Map();
	return {
		on(channel: string, fn: (d: unknown) => void) {
			const list = handlers.get(channel) ?? [];
			list.push(fn);
			handlers.set(channel, list);
			return () => {
				const l = handlers.get(channel) ?? [];
				handlers.set(
					channel,
					l.filter((f) => f !== fn),
				);
			};
		},
		emit(channel: string, data: unknown) {
			for (const fn of handlers.get(channel) ?? []) fn(data);
		},
	};
}

describe("PerSliceLog", () => {
	test("writes tff:phase event to <root>/.tff/logs/<sliceLabel>.jsonl", () => {
		const root = mkdtempSync(join(tmpdir(), "tff-psl-"));
		const log = new PerSliceLog(root);
		const bus = makeBus();
		log.subscribe(bus);
		bus.emit("tff:phase", {
			timestamp: "2026-04-17T00:00:00Z",
			sliceId: "s1",
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			type: "phase_complete",
			phase: "verify",
		});
		const logPath = join(root, ".tff", "logs", "M01-S01.jsonl");
		expect(existsSync(logPath)).toBe(true);
		const line = JSON.parse(readFileSync(logPath, "utf-8").trim()) as Record<string, unknown>;
		expect(line.ch).toBe("tff:phase");
		expect(line.type).toBe("phase_complete");
	});

	test("routes sliceLabel=null events to ambient.jsonl", () => {
		const root = mkdtempSync(join(tmpdir(), "tff-psl-"));
		const log = new PerSliceLog(root);
		const bus = makeBus();
		log.subscribe(bus);
		bus.emit("tff:tool", {
			timestamp: "t",
			sliceId: null,
			sliceLabel: null,
			milestoneNumber: null,
			type: "tool_call",
			toolCallId: "x",
			toolName: "y",
			input: {},
			output: {},
			isError: false,
			durationMs: 0,
			startedAt: "t",
			phase: null,
		});
		expect(existsSync(join(root, ".tff", "logs", "ambient.jsonl"))).toBe(true);
	});

	test("dispose() stops further writes", () => {
		const root = mkdtempSync(join(tmpdir(), "tff-psl-"));
		const log = new PerSliceLog(root);
		const bus = makeBus();
		log.subscribe(bus);
		log.dispose();
		bus.emit("tff:phase", {
			timestamp: "t",
			sliceId: "s1",
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			type: "phase_complete",
			phase: "verify",
		});
		expect(existsSync(join(root, ".tff", "logs", "M01-S01.jsonl"))).toBe(false);
	});
});

describe("readPerSliceLog", () => {
	test("returns empty when file absent", () => {
		const root = mkdtempSync(join(tmpdir(), "tff-read-"));
		expect(readPerSliceLog(root, "M01-S01")).toEqual([]);
	});

	test("round-trip: writes then reads parsed lines", () => {
		const root = mkdtempSync(join(tmpdir(), "tff-read-"));
		const log = new PerSliceLog(root);
		const bus = makeBus();
		log.subscribe(bus);
		bus.emit("tff:tool", {
			timestamp: "t1",
			sliceId: "s1",
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			phase: "verify",
			type: "tool_call",
			toolCallId: "a",
			toolName: "bash",
			input: { command: "ls" },
			output: {},
			isError: false,
			durationMs: 1,
			startedAt: "t1",
		});
		const lines = readPerSliceLog(root, "M01-S01");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.ch).toBe("tff:tool");
		expect(lines[0]?.toolName).toBe("bash");
	});
});
