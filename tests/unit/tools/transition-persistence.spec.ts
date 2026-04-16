import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { EventLogger } from "../../../src/common/event-logger.js";
import { handleTransition } from "../../../src/tools/transition.js";
import { must } from "../../helpers.js";

function makeFakePi(opts: { swallow?: boolean } = {}): ExtensionAPI {
	return {
		events: {
			emit: () => {
				// No-op: simulates a broken/unsubscribed event bus.
				// Real pi emits synchronously; a no-op here means the
				// event-logger never runs, so slice.status never transitions.
				if (opts.swallow) return;
			},
			on: () => () => {},
		},
	} as unknown as ExtensionAPI;
}

describe("handleTransition persistence check", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, {
			milestoneId,
			number: 1,
			title: "Auth",
		});
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
	});

	it("returns isError when emit does not persist the status change", () => {
		const pi = makeFakePi({ swallow: true });
		const result = handleTransition(pi, db, sliceId, 1, "verifying");

		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toMatch(/slice\.status is still/i);
		expect(result.details.persistenceVerified).toBe(false);
		expect(result.details.expected).toBe("verifying");

		const after = must(getSlice(db, sliceId));
		expect(after.status).toBe("executing"); // unchanged, as expected
	});
});

class MockBus {
	private handlers = new Map<string, Array<(d: unknown) => void>>();
	on(channel: string, h: (d: unknown) => void) {
		const l = this.handlers.get(channel) ?? [];
		l.push(h);
		this.handlers.set(channel, l);
		return () => {
			const u = this.handlers.get(channel) ?? [];
			const i = u.indexOf(h);
			if (i !== -1) u.splice(i, 1);
		};
	}
	emit(channel: string, d: unknown) {
		for (const h of this.handlers.get(channel) ?? []) h(d);
	}
}

describe("handleTransition with real event logger", () => {
	it("returns success with persistenceVerified=true when handler runs", () => {
		const db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);

		const logsDir = mkdtempSync(join(tmpdir(), "tff-transition-happy-"));
		const bus = new MockBus();
		const logger = new EventLogger(db, logsDir, "/nonexistent-reconcile-fallback");
		logger.subscribe(bus as unknown as Parameters<EventLogger["subscribe"]>[0]);

		const pi = {
			events: {
				emit: (ch: string, d: unknown) => bus.emit(ch, d),
				on: (ch: string, h: (d: unknown) => void) => bus.on(ch, h),
			},
		} as unknown as ExtensionAPI;

		const result = handleTransition(pi, db, sliceId, 1, "verifying");

		expect(result.isError).toBeUndefined();
		expect(result.details.persistenceVerified).toBe(true);

		const after = must(getSlice(db, sliceId));
		expect(after.status).toBe("verifying");

		logger.dispose();
		db.close();
		rmSync(logsDir, { recursive: true, force: true });
	});
});
