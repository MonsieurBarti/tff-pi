import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { EventLogger } from "../../../src/common/event-logger.js";

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
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

let db: Database.Database;
let root: string;
let sliceId: string;
let bus: MockEventBus;
let logger: EventLogger;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reconciler-integ-"));
	db = openDatabase(":memory:");
	applyMigrations(db);
	const projectId = insertProject(db, { name: "p", vision: "v" });
	const milestoneId = insertMilestone(db, {
		projectId,
		number: 1,
		name: "m",
		branch: "m01",
	});
	sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
	bus = new MockEventBus();
	logger = new EventLogger(db, join(root, ".tff", "logs"), root);
	logger.subscribe(bus);
});

afterEach(() => {
	logger.dispose();
	db.close();
	rmSync(root, { recursive: true, force: true });
});

describe("EventLogger → reconciler integration", () => {
	it("reconciles slice.status on phase_start", () => {
		bus.emit("tff:phase", {
			type: "phase_start",
			phase: "plan",
			sliceId,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			timestamp: new Date().toISOString(),
		});
		expect(getSlice(db, sliceId)?.status).toBe("planning");
	});

	it("reconciles slice.status on phase_failed (verify → executing)", () => {
		bus.emit("tff:phase", {
			type: "phase_start",
			phase: "verify",
			sliceId,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			timestamp: new Date(Date.now() - 1000).toISOString(),
		});
		bus.emit("tff:phase", {
			type: "phase_failed",
			phase: "verify",
			sliceId,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			timestamp: new Date().toISOString(),
			error: "test",
		});
		expect(getSlice(db, sliceId)?.status).toBe("executing");
	});

	it("emits tff:derived event when slice.status changes", () => {
		bus.emit("tff:phase", {
			type: "phase_start",
			phase: "plan",
			sliceId,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			timestamp: new Date().toISOString(),
		});
		const row = db
			.prepare(
				"SELECT payload FROM event_log WHERE channel = 'tff:derived' ORDER BY id DESC LIMIT 1",
			)
			.get() as { payload: string } | undefined;
		expect(row).toBeDefined();
		const payload = JSON.parse(row?.payload ?? "{}");
		expect(payload.from).toBe("created");
		expect(payload.to).toBe("planning");
	});
});
