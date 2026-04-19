import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import * as projectionModule from "../../../src/common/projection.js";
import { handleWriteSpec } from "../../../src/tools/write-spec.js";

describe("handleWriteSpec — event log", () => {
	test("appends one write-spec event and advances cursor", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-spec-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(sId);

		const result = handleWriteSpec(db, root, sId, "# Spec\n");
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-spec");
		expect(events[0]?.params).toEqual({ sliceId: sId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});
});

describe("handleWriteSpec — projection throw rolls back tx", () => {
	test("projectCommand throw leaves event log empty and cursor at 0, tool propagates the error", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-spec-rollback-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(sId);

		const spy = vi.spyOn(projectionModule, "projectCommand").mockImplementation(() => {
			throw new Error("injected projection failure");
		});

		// handleWriteSpec does not catch tx errors — the throw propagates to caller.
		let threw = false;
		try {
			handleWriteSpec(db, root, sId, "# Spec\n");
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
		expect(readEvents(root)).toHaveLength(0);
		expect(loadCursor(db).lastRow).toBe(0);

		spy.mockRestore();
	});
});
