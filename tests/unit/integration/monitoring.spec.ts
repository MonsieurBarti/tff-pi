import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { makeBaseEvent } from "../../../src/common/events.js";
import type { PhaseEvent, PipelineEvent } from "../../../src/common/events.js";
import { TUIMonitor } from "../../../src/common/tui-monitor.js";
import { must } from "../../helpers.js";

// ---------------------------------------------------------------------------
// Mock EventBus — synchronously delivers emit() calls to on() subscribers
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
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function seedSlice(db: Database.Database): { sliceId: string; sliceLabel: string } {
	insertProject(db, { name: "TFF", vision: "Vision" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	return { sliceId, sliceLabel: "M01-S01" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("monitoring integration", () => {
	let db: Database.Database;
	let logsDir: string;
	let sliceId: string;
	let sliceLabel: string;
	let bus: MockEventBus;

	beforeEach(() => {
		db = createTestDb();
		const seed = seedSlice(db);
		sliceId = seed.sliceId;
		sliceLabel = seed.sliceLabel;
		logsDir = mkdtempSync(join(tmpdir(), "tff-monitoring-integration-"));
		bus = new MockEventBus();
	});

	afterEach(() => {
		rmSync(logsDir, { recursive: true, force: true });
	});

	it("full pipeline: events flow through logger → DB + JSONL", () => {
		const logger = new EventLogger(db, logsDir);
		logger.subscribe(bus);

		const base = makeBaseEvent(sliceId, sliceLabel, 1);

		const phaseStart: PhaseEvent = {
			...base,
			type: "phase_start",
			phase: "research",
		};
		const phaseComplete: PhaseEvent = {
			...base,
			type: "phase_complete",
			phase: "research",
			durationMs: 4200,
		};

		bus.emit("tff:phase", phaseStart);
		bus.emit("tff:phase", phaseComplete);

		// DB: phase_run row exists with status "completed" and durationMs
		const runs = getPhaseRuns(db, sliceId);
		expect(runs).toHaveLength(1);
		const run = must(runs[0]);
		expect(run.phase).toBe("research");
		expect(run.status).toBe("completed");
		expect(run.durationMs).toBe(4200);

		// DB: event_log has 2 entries
		const entries = getEventLog(db, sliceId);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.type).toBe("phase_start");
		expect(entries[1]?.type).toBe("phase_complete");

		// JSONL: file exists and has exactly 2 lines
		const jsonlPath = join(logsDir, `${sliceLabel}.jsonl`);
		expect(existsSync(jsonlPath)).toBe(true);
		const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(must(lines[0])).type).toBe("phase_start");
		expect(JSON.parse(must(lines[1])).type).toBe("phase_complete");
	});

	it("TUIMonitor updates status and widget on events", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const ui = { setStatus, setWidget };

		const monitor = new TUIMonitor(ui);
		monitor.subscribe(bus);

		const base = makeBaseEvent(sliceId, sliceLabel, 1);

		const pipelineStart: PipelineEvent = {
			...base,
			type: "pipeline_start",
		};
		const phaseStart: PhaseEvent = {
			...base,
			type: "phase_start",
			phase: "research",
		};

		bus.emit("tff:pipeline", pipelineStart);
		bus.emit("tff:phase", phaseStart);

		// setStatus called with "tff" key containing the slice label
		expect(setStatus).toHaveBeenCalledWith("tff", expect.stringContaining(sliceLabel));

		// setWidget called with "tff-progress" key and belowEditor placement
		expect(setWidget).toHaveBeenCalledWith(
			"tff-progress",
			expect.any(Array),
			expect.objectContaining({ placement: "belowEditor" }),
		);
	});
});
