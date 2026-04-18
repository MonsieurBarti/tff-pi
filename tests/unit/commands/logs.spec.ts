import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { handleLogs } from "../../../src/commands/logs.js";
import { PerSliceLog } from "../../../src/common/per-slice-log.js";

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

describe("handleLogs", () => {
	let root: string;
	let bus: ReturnType<typeof makeBus>;
	let log: PerSliceLog;
	const LABEL = "M01-S01";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-logs-"));
		bus = makeBus();
		log = new PerSliceLog(root);
		log.subscribe(bus);
	});

	it("returns no-events message when empty", () => {
		const result = handleLogs(root, LABEL);
		expect(result).toContain("No events");
	});

	it("returns timeline for a slice", () => {
		bus.emit("tff:phase", {
			timestamp: "2026-04-11T10:30:00.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "phase_started",
			phase: "research",
		});
		bus.emit("tff:phase", {
			timestamp: "2026-04-11T10:31:30.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "phase_completed",
			phase: "research",
			durationMs: 90000,
		});

		const result = handleLogs(root, LABEL);
		expect(result).toContain("10:30:00");
		expect(result).toContain("phase_started");
		expect(result).toContain("research");
		expect(result).toContain("10:31:30");
		expect(result).toContain("phase_completed");
		expect(result).toContain("1m30s");
	});

	it("formats wave and task count fields", () => {
		bus.emit("tff:wave", {
			timestamp: "2026-04-11T11:00:00.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "wave_started",
			wave: 2,
			totalWaves: 4,
			taskCount: 3,
		});

		const result = handleLogs(root, LABEL);
		expect(result).toContain("wave=2/4");
		expect(result).toContain("tasks=3");
	});

	it("formats verdict and tier fields", () => {
		bus.emit("tff:review", {
			timestamp: "2026-04-11T12:00:00.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "review_verdict",
			tier: "SSS",
			verdict: "approved",
		});

		const result = handleLogs(root, LABEL);
		expect(result).toContain("tier=SSS");
		expect(result).toContain("approved");
	});

	it("truncates error to 60 chars", () => {
		const longError = "a".repeat(80);
		bus.emit("tff:phase", {
			timestamp: "2026-04-11T13:00:00.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "phase_failed",
			error: longError,
		});

		const result = handleLogs(root, LABEL);
		expect(result).toContain("a".repeat(60));
		expect(result).not.toContain("a".repeat(61));
	});

	it("returns json when format is json", () => {
		bus.emit("tff:phase", {
			timestamp: "2026-04-11T10:00:00.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "phase_started",
			phase: "plan",
		});
		bus.emit("tff:phase", {
			timestamp: "2026-04-11T10:05:00.000Z",
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "phase_started",
			phase: "execute",
		});

		const result = handleLogs(root, LABEL, { json: true });
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("uses fallback time when timestamp missing", () => {
		bus.emit("tff:phase", {
			sliceId: "s1",
			sliceLabel: LABEL,
			milestoneNumber: 1,
			type: "phase_started",
			phase: "discuss",
		});

		const result = handleLogs(root, LABEL);
		expect(result).toContain("??:??:??");
	});
});
