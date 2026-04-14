import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getEventLog,
	getMilestones,
	getPhaseRuns,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { EventLogger } from "../../../src/common/event-logger.js";
import { type PhaseEvent, TFF_CHANNELS, type ToolCallEvent } from "../../../src/common/events.js";
import { must } from "../../helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (data: unknown) => void;

class MockEventBus {
	private handlers = new Map<string, Handler[]>();

	on(channel: string, handler: Handler): () => void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
		return () => {
			const updated = this.handlers.get(channel) ?? [];
			const idx = updated.indexOf(handler);
			if (idx !== -1) updated.splice(idx, 1);
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(data);
		}
	}

	subscribedChannels(): string[] {
		return [...this.handlers.keys()];
	}
}

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function seedSlice(db: Database.Database): string {
	insertProject(db, { name: "TFF", vision: "Vision" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	return must(getSlices(db, milestoneId)[0]).id;
}

function makePhaseEvent(sliceId: string, overrides: Partial<PhaseEvent> = {}): PhaseEvent {
	return {
		timestamp: new Date().toISOString(),
		sliceId,
		sliceLabel: "M01-S01",
		milestoneNumber: 1,
		type: "phase_start",
		phase: "research",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventLogger", () => {
	let db: Database.Database;
	let logsDir: string;
	let sliceId: string;
	let bus: MockEventBus;
	let logger: EventLogger;

	beforeEach(() => {
		db = createTestDb();
		sliceId = seedSlice(db);
		logsDir = mkdtempSync(join(tmpdir(), "tff-event-logger-"));
		bus = new MockEventBus();
		logger = new EventLogger(db, logsDir, logsDir);
	});

	afterEach(() => {
		rmSync(logsDir, { recursive: true, force: true });
	});

	describe("subscribe", () => {
		it("subscribes to all 5 TFF channels", () => {
			logger.subscribe(bus);
			const channels = bus.subscribedChannels().sort();
			expect(channels).toEqual([...TFF_CHANNELS].sort());
		});
	});

	describe("event_log persistence", () => {
		it("writes a phase event to the event_log table", () => {
			logger.subscribe(bus);
			const event = makePhaseEvent(sliceId);
			bus.emit("tff:phase", event);

			const entries = getEventLog(db, sliceId, "tff:phase");
			expect(entries).toHaveLength(1);
			const entry = must(entries[0]);
			expect(entry.channel).toBe("tff:phase");
			expect(entry.type).toBe("phase_start");
			expect(entry.sliceId).toBe(sliceId);
			expect(JSON.parse(entry.payload)).toMatchObject({ type: "phase_start", phase: "research" });
		});

		it("writes events from multiple channels to event_log", () => {
			logger.subscribe(bus);

			bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_start", phase: "research" }));
			bus.emit("tff:pipeline", {
				timestamp: new Date().toISOString(),
				sliceId,
				sliceLabel: "M01-S01",
				milestoneNumber: 1,
				type: "pipeline_start",
			});

			// Filter to pipeline channels only — tff:derived entries from reconciler are also written
			const phaseEntries = getEventLog(db, sliceId, "tff:phase");
			const pipelineEntries = getEventLog(db, sliceId, "tff:pipeline");
			expect(phaseEntries).toHaveLength(1);
			expect(pipelineEntries).toHaveLength(1);
			expect(phaseEntries[0]?.channel).toBe("tff:phase");
			expect(pipelineEntries[0]?.channel).toBe("tff:pipeline");
		});
	});

	describe("phase_run upsert", () => {
		it("creates a phase_run record on phase_start", () => {
			logger.subscribe(bus);
			bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_start", phase: "research" }));

			const runs = getPhaseRuns(db, sliceId);
			expect(runs).toHaveLength(1);
			const run = must(runs[0]);
			expect(run.phase).toBe("research");
			expect(run.status).toBe("started");
			expect(run.finishedAt).toBeNull();
		});

		it("updates phase_run on phase_complete with durationMs", () => {
			logger.subscribe(bus);
			const startTs = new Date().toISOString();
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, { type: "phase_start", phase: "plan", timestamp: startTs }),
			);

			const finishTs = new Date().toISOString();
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, {
					type: "phase_complete",
					phase: "plan",
					timestamp: finishTs,
					durationMs: 5000,
				}),
			);

			const runs = getPhaseRuns(db, sliceId);
			expect(runs).toHaveLength(1);
			const run = must(runs[0]);
			expect(run.status).toBe("completed");
			expect(run.finishedAt).toBe(finishTs);
			expect(run.durationMs).toBe(5000);
		});

		it("updates phase_run on phase_failed with error", () => {
			logger.subscribe(bus);
			bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_start", phase: "execute" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, {
					type: "phase_failed",
					phase: "execute",
					error: "Agent timed out",
					durationMs: 3000,
				}),
			);

			const runs = getPhaseRuns(db, sliceId);
			expect(runs).toHaveLength(1);
			const run = must(runs[0]);
			expect(run.status).toBe("failed");
			expect(run.error).toBe("Agent timed out");
		});

		it("keeps active phase_run key on phase_retried and removes on phase_complete", () => {
			logger.subscribe(bus);
			bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_start", phase: "research" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, {
					type: "phase_retried",
					phase: "research",
					feedback: "Try again",
				}),
			);

			// After retry the run is still tracked, so a subsequent complete should update the same run
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, {
					type: "phase_complete",
					phase: "research",
					durationMs: 7000,
				}),
			);

			const runs = getPhaseRuns(db, sliceId);
			// Only 1 phase_run was inserted (start creates one, retried + complete update it)
			expect(runs).toHaveLength(1);
			const run = must(runs[0]);
			expect(run.status).toBe("completed");
		});

		it("stores tier in metadata on phase_complete with tier", () => {
			logger.subscribe(bus);
			bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_start", phase: "review" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, {
					type: "phase_complete",
					phase: "review",
					tier: "S",
					durationMs: 1000,
				}),
			);

			const runs = getPhaseRuns(db, sliceId);
			const run = must(runs[0]);
			expect(run.metadata).not.toBeNull();
			const meta = JSON.parse(run.metadata as string);
			expect(meta.tier).toBe("S");
		});

		it("ignores phase events without a prior phase_start (no phase_run to update)", () => {
			logger.subscribe(bus);
			// Emit a complete without a start — should not throw and no phase_run created
			expect(() => {
				bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_complete", phase: "plan" }));
			}).not.toThrow();

			const runs = getPhaseRuns(db, sliceId);
			expect(runs).toHaveLength(0);
		});

		it("does not create phase_run for non-phase channels", () => {
			logger.subscribe(bus);
			bus.emit("tff:pipeline", {
				timestamp: new Date().toISOString(),
				sliceId,
				sliceLabel: "M01-S01",
				milestoneNumber: 1,
				type: "pipeline_start",
			});

			const runs = getPhaseRuns(db, sliceId);
			expect(runs).toHaveLength(0);
		});
	});

	describe("JSONL file appending", () => {
		it("appends event as JSONL to <sliceLabel>.jsonl", () => {
			logger.subscribe(bus);
			const event = makePhaseEvent(sliceId, { type: "phase_start", phase: "discuss" });
			bus.emit("tff:phase", event);

			const filePath = join(logsDir, "M01-S01.jsonl");
			const content = readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(must(lines[0]));
			expect(parsed.ch).toBe("tff:phase");
			expect(parsed.type).toBe("phase_start");
			expect(parsed.ts).toBeDefined();
		});

		it("appends multiple events as separate JSONL lines", () => {
			logger.subscribe(bus);
			bus.emit("tff:phase", makePhaseEvent(sliceId, { type: "phase_start", phase: "research" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent(sliceId, { type: "phase_complete", phase: "research", durationMs: 100 }),
			);

			const filePath = join(logsDir, "M01-S01.jsonl");
			const content = readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(must(lines[0])).type).toBe("phase_start");
			expect(JSON.parse(must(lines[1])).type).toBe("phase_complete");
		});

		it("creates separate JSONL files per sliceLabel", () => {
			const sliceId2 = "fake-slice-2";
			logger.subscribe(bus);

			bus.emit("tff:phase", makePhaseEvent(sliceId, { sliceLabel: "M01-S01" }));
			bus.emit("tff:pipeline", {
				timestamp: new Date().toISOString(),
				sliceId: sliceId2,
				sliceLabel: "M01-S02",
				milestoneNumber: 1,
				type: "pipeline_start",
			});

			const file1 = readFileSync(join(logsDir, "M01-S01.jsonl"), "utf-8");
			const file2 = readFileSync(join(logsDir, "M01-S02.jsonl"), "utf-8");
			expect(file1.trim().split("\n")).toHaveLength(1);
			expect(file2.trim().split("\n")).toHaveLength(1);
		});
	});
});

describe("EventLogger nullable-slice routing", () => {
	let db: Database.Database;
	let logsDir: string;
	let bus: MockEventBus;
	let logger: EventLogger;

	beforeEach(() => {
		db = createTestDb();
		logsDir = mkdtempSync(join(tmpdir(), "tff-el-"));
		bus = new MockEventBus();
		logger = new EventLogger(db, logsDir, logsDir);
	});

	afterEach(() => {
		rmSync(logsDir, { recursive: true, force: true });
	});

	it("writes tff:tool events with string sliceId to per-slice JSONL", () => {
		logger.subscribe(bus);

		const event: ToolCallEvent = {
			timestamp: "2026-04-13T12:00:00.000Z",
			type: "tool_call",
			sliceId: "s1",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "ls" },
			output: "x",
			isError: false,
			durationMs: 12,
			startedAt: "2026-04-13T12:00:00.000Z",
		};
		bus.emit("tff:tool", event);

		const files = readdirSync(logsDir);
		expect(files).toContain("M09-S01.jsonl");
		const content = readFileSync(join(logsDir, "M09-S01.jsonl"), "utf-8");
		expect(content).toContain('"ch":"tff:tool"');
		expect(content).toContain('"toolName":"bash"');

		const row = db
			.prepare("SELECT channel, type, slice_id FROM event_log WHERE channel = 'tff:tool' LIMIT 1")
			.get() as { channel: string; type: string; slice_id: string };
		expect(row).toMatchObject({ channel: "tff:tool", type: "tool_call", slice_id: "s1" });
	});

	it("writes tff:tool events with null sliceId to ambient.jsonl and empty-string DB slice_id", () => {
		logger.subscribe(bus);

		const event: ToolCallEvent = {
			timestamp: "2026-04-13T12:00:00.000Z",
			type: "tool_call",
			sliceId: null,
			sliceLabel: null,
			milestoneNumber: null,
			phase: null,
			toolCallId: "c2",
			toolName: "bash",
			input: { command: "ls" },
			output: "x",
			isError: false,
			durationMs: 5,
			startedAt: "2026-04-13T12:00:00.000Z",
		};
		bus.emit("tff:tool", event);

		const files = readdirSync(logsDir);
		expect(files).toContain("ambient.jsonl");

		const row = db
			.prepare("SELECT channel, type, slice_id FROM event_log WHERE channel = 'tff:tool' LIMIT 1")
			.get() as { channel: string; type: string; slice_id: string };
		expect(row.slice_id).toBe("");
	});
});
