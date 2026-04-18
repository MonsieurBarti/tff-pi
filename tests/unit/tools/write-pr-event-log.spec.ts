import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleWritePr } from "../../../src/tools/write-pr.js";

function seeded() {
	const db = new Database(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-write-pr-"));
	mkdirSync(join(root, ".tff"), { recursive: true });
	mkdirSync(join(root, ".tff", "milestones"), { recursive: true });
	return { db, root };
}

function forceSliceStatus(db: Database.Database, sliceId: string, status: string): void {
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(status, sliceId);
}

describe("handleWritePr — event log", () => {
	test("appends write-pr event, writes PR.md at final path, no tmp left", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceSliceStatus(db, sId, "verifying");
		insertPhaseRun(db, { sliceId: sId, phase: "verify", status: "started", startedAt: "t0" });

		const result = handleWritePr(db, root, sId, {
			description: "desc",
			testSteps: "1. do thing",
		});

		expect(result.isError).toBeFalsy();
		expect(loadCursor(db).lastRow).toBe(1);

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-pr");
		expect((events[0]?.params as { sliceId?: string }).sliceId).toBe(sId);

		// PR.md written at final path (under .tff/); no .tmp left
		const prPath = join(root, ".tff", "milestones", "M01", "slices", "M01-S01", "PR.md");
		expect(existsSync(prPath)).toBe(true);
		expect(existsSync(`${prPath}.tmp`)).toBe(false);
	});

	test("returns isError and writes no event when precondition fails (slice not verifying)", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		// Slice is in default 'created' status — precondition will fail

		const result = handleWritePr(db, root, sId, {
			description: "desc",
			testSteps: "1. thing",
		});

		expect(result.isError).toBe(true);
		expect(readEvents(root)).toHaveLength(0);
	});
});
