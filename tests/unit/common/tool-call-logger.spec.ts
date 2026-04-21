import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCurrentPhase, setCurrentPhase } from "../../../src/common/current-phase-context.js";
import type { EventBus } from "../../../src/common/events.js";
import { ToolCallLogger } from "../../../src/common/tool-call-logger.js";

type PiHandler = (event: unknown, ctx?: unknown) => unknown;

function makeFakePi(): {
	pi: { on: (event: string, handler: PiHandler) => () => void };
	fire: (event: string, data: unknown) => void;
} {
	const handlers = new Map<string, Set<PiHandler>>();
	return {
		pi: {
			on: (event, handler) => {
				let set = handlers.get(event);
				if (!set) {
					set = new Set();
					handlers.set(event, set);
				}
				set.add(handler);
				return () => {
					set.delete(handler);
				};
			},
		},
		fire: (event, data) => {
			for (const h of handlers.get(event) ?? []) h(data);
		},
	};
}

function makeFakeBus(): { bus: EventBus; emissions: Array<{ channel: string; data: unknown }> } {
	const emissions: Array<{ channel: string; data: unknown }> = [];
	return {
		bus: {
			on: () => () => {},
			emit: (channel, data) => emissions.push({ channel, data }),
		},
		emissions,
	};
}

describe("ToolCallLogger", () => {
	beforeEach(() => {
		clearCurrentPhase();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
	});
	afterEach(() => {
		clearCurrentPhase();
		vi.useRealTimers();
	});

	it("ignores non-allow-list tools (e.g., read)", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_call", { toolCallId: "c1", toolName: "read", input: { path: "x" } });
		fire("tool_execution_end", {
			toolCallId: "c1",
			toolName: "read",
			result: { content: "..." },
			isError: false,
		});

		expect(emissions).toHaveLength(0);
	});

	it("emits tff:tool when a bash call completes", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_call", { toolCallId: "c2", toolName: "bash", input: { command: "ls" } });
		vi.advanceTimersByTime(50);
		fire("tool_execution_end", {
			toolCallId: "c2",
			toolName: "bash",
			result: "a.ts\nb.ts",
			isError: false,
		});

		expect(emissions).toHaveLength(1);
		expect(emissions[0]?.channel).toBe("tff:tool");
		expect(emissions[0]?.data).toMatchObject({
			type: "tool_call",
			toolCallId: "c2",
			toolName: "bash",
			input: { command: "ls" },
			output: "a.ts\nb.ts",
			isError: false,
			durationMs: 50,
			sliceId: null,
		});
	});

	it("tags slice context when a phase is active", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		setCurrentPhase({
			sliceId: "slice-abc",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});

		fire("tool_call", { toolCallId: "c3", toolName: "write", input: { path: "a.ts" } });
		fire("tool_execution_end", {
			toolCallId: "c3",
			toolName: "write",
			result: "ok",
			isError: false,
		});

		expect(emissions[0]?.data).toMatchObject({
			sliceId: "slice-abc",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});
	});

	it("isError=true is propagated", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_call", { toolCallId: "c4", toolName: "bash", input: { command: "false" } });
		fire("tool_execution_end", {
			toolCallId: "c4",
			toolName: "bash",
			result: "exit 1",
			isError: true,
		});

		expect(emissions[0]?.data).toMatchObject({ isError: true });
	});

	it("tool_execution_end without matching tool_call is a no-op (filtered or lost)", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_execution_end", {
			toolCallId: "unknown",
			toolName: "bash",
			result: "x",
			isError: false,
		});

		expect(emissions).toHaveLength(0);
	});

	it("captures tff_write_* allow-prefix tools", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_call", {
			toolCallId: "c5",
			toolName: "tff_write_plan",
			input: { content: "..." },
		});
		fire("tool_execution_end", {
			toolCallId: "c5",
			toolName: "tff_write_plan",
			result: "written",
			isError: false,
		});

		expect(emissions).toHaveLength(1);
		expect(emissions[0]?.data).toMatchObject({ toolName: "tff_write_plan" });
	});

	it("dispose unsubscribes and clears pending", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_call", { toolCallId: "c6", toolName: "bash", input: { command: "ls" } });
		logger.dispose();
		fire("tool_execution_end", {
			toolCallId: "c6",
			toolName: "bash",
			result: "ok",
			isError: false,
		});

		expect(emissions).toHaveLength(0);
	});

	it("stale pending entries (>5 min) are GC'd on next call", () => {
		const { pi, fire } = makeFakePi();
		const { bus, emissions } = makeFakeBus();
		const logger = new ToolCallLogger(pi, bus);
		logger.subscribe();

		fire("tool_call", { toolCallId: "old", toolName: "bash", input: { command: "slow" } });
		vi.advanceTimersByTime(6 * 60 * 1000);
		fire("tool_call", { toolCallId: "new", toolName: "bash", input: { command: "fast" } });
		fire("tool_execution_end", {
			toolCallId: "old",
			toolName: "bash",
			result: "late",
			isError: false,
		});

		expect(emissions).toHaveLength(0);
	});
});
