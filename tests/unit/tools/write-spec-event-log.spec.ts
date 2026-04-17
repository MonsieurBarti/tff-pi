import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleWriteSpec } from "../../../src/tools/write-spec.js";

describe("handleWriteSpec — event log", () => {
	test("appends one write-spec event and advances cursor", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-spec-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });

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
