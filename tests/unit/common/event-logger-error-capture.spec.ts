import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getEventLog,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { EventLogger } from "../../../src/common/event-logger.js";
import { must } from "../../helpers.js";

class MockEventBus {
	private handlers = new Map<string, Array<(data: unknown) => void>>();
	on(channel: string, h: (data: unknown) => void) {
		const list = this.handlers.get(channel) ?? [];
		list.push(h);
		this.handlers.set(channel, list);
		return () => {
			const u = this.handlers.get(channel) ?? [];
			const i = u.indexOf(h);
			if (i !== -1) u.splice(i, 1);
		};
	}
	emit(channel: string, data: unknown) {
		for (const h of this.handlers.get(channel) ?? []) h(data);
	}
}

describe("EventLogger error capture", () => {
	let db: Database.Database;
	let logsDir: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		logsDir = mkdtempSync(join(tmpdir(), "tff-evlogger-err-"));
	});

	afterEach(() => {
		db.close();
		rmSync(logsDir, { recursive: true, force: true });
	});

	it("writes event_log row with tff:error channel when a handler throws", () => {
		const bus = new MockEventBus();
		const logger = new EventLogger(db, logsDir, "/nonexistent-root-forces-reconcile-skip");
		logger.subscribe(bus as unknown as Parameters<EventLogger["subscribe"]>[0]);

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// Emit a tff:phase event that will fail inside handlePhaseRun because
		// required fields (phase) are missing. The catch should surface the
		// failure to event_log + stderr.
		bus.emit("tff:phase", {
			type: "phase_start",
			sliceId,
			sliceLabel: "M01-S01",
			timestamp: new Date().toISOString(),
			// phase intentionally omitted — insertPhaseRun requires it
		});

		const rows = getEventLog(db, sliceId, "tff:error");
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const payload = JSON.parse(must(rows[0]).payload) as {
			component: string;
			sourceChannel: string;
			message: string;
		};
		expect(payload.component).toBe("event-logger");
		expect(payload.sourceChannel).toBe("tff:phase");
		expect(payload.message.length).toBeGreaterThan(0);

		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
		logger.dispose();
	});
});
