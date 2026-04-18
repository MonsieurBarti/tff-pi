import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { appendCommand, loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleShipChanges } from "../../../src/tools/ship-changes.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as Parameters<typeof handleShipChanges>[0];
}

describe("handleShipChanges — event log", () => {
	test("appends one ship-changes event, advances cursor", async () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-ship-changes-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'shipping', tier = 'S' WHERE id = ?").run(sId);
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		// write-pr must be in the event log before ship-changes (precondition)
		appendCommand(root, "write-pr", { sliceId: sId });

		const pi = makePi();
		const result = await handleShipChanges(pi, db, root, sId, "Reviewer asked for changes.");
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		// First event is write-pr (seeded for precondition), second is ship-changes
		expect(events).toHaveLength(2);
		const shipChangesEvent = events.find((e) => e.cmd === "ship-changes");
		expect(shipChangesEvent).toBeDefined();
		expect(shipChangesEvent?.params).toMatchObject({ sliceId: sId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(2);
		expect(cursor.lastHash).toBe(shipChangesEvent?.hash);
	});
});
