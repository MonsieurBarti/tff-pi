import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { setLogBasePath, setStderrLoggingEnabled } from "../../../src/common/logger.js";
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
	let auditRoot: string;
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
		auditRoot = mkdtempSync(join(tmpdir(), "tff-audit-"));
		setLogBasePath(auditRoot);
		setStderrLoggingEnabled(false);
	});

	afterEach(() => {
		db.close();
		rmSync(logsDir, { recursive: true, force: true });
		rmSync(auditRoot, { recursive: true, force: true });
		setStderrLoggingEnabled(true);
	});

	it("writes audit-log entry when a handler throws; no tff:error row in event_log", () => {
		const bus = new MockEventBus();
		const logger = new EventLogger(db, logsDir, "/nonexistent-root-forces-reconcile-skip");
		logger.subscribe(bus as unknown as Parameters<EventLogger["subscribe"]>[0]);

		bus.emit("tff:phase", {
			type: "phase_start",
			sliceId,
			sliceLabel: "M01-S01",
			timestamp: new Date().toISOString(),
		});

		// Post-M12-S01: no event_log row with channel='tff:error' is written.
		expect(getEventLog(db, sliceId, "tff:error")).toEqual([]);

		// Audit-log carries the structured error.
		const auditPath = join(auditRoot, ".tff", "audit-log.jsonl");
		expect(existsSync(auditPath)).toBe(true);
		const lines = readFileSync(auditPath, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const first = lines[0] as {
			component: string;
			message: string;
			ctx: { tool?: string };
		};
		expect(first.component).toBe("event-logger");
		expect(first.message.length).toBeGreaterThan(0);
		expect(first.ctx.tool).toBe("tff:phase");

		logger.dispose();
	});
});
