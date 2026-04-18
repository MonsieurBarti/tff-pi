import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleTransition } from "../../../src/tools/transition.js";

describe("handleTransition — event log", () => {
	test("appends transition event, sets slice.status, advances cursor", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-transition-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'executing', tier = 'S' WHERE id = ?").run(sId);

		const fakePi = { events: { emit() {} } } as never;
		const result = handleTransition(fakePi, db, sId, 1, "verifying", root);

		expect(result.isError).toBeFalsy();
		expect(getSlice(db, sId)?.status).toBe("verifying");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("transition");
		expect(events[0]?.params).toMatchObject({ sliceId: sId, to: "verifying", phase: "verify" });
		expect((events[0]?.params as Record<string, unknown>).startedAt).toBeDefined();

		expect(loadCursor(db).lastRow).toBe(1);
	});
});
