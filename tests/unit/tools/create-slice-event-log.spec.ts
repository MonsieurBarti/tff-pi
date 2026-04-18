import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	applyMigrations,
	getSlices,
	insertMilestone,
	insertProject,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleCreateSlice } from "../../../src/tools/create-slice.js";
import { must } from "../../helpers.js";

describe("handleCreateSlice — event log", () => {
	let db: Database.Database;
	let root: string;
	let milestoneId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-cs-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		milestoneId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("appends create-slice event, creates DB row, advances cursor", () => {
		const result = handleCreateSlice(db, root, milestoneId, "Auth");

		expect(result.isError).toBeFalsy();
		const sliceId = result.details.sliceId as string;
		expect(sliceId).toBeDefined();

		const slices = getSlices(db, milestoneId);
		expect(slices).toHaveLength(1);
		expect(must(slices[0]).title).toBe("Auth");
		expect(must(slices[0]).id).toBe(sliceId);

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("create-slice");
		expect(events[0]?.params).toMatchObject({
			id: sliceId,
			milestoneId,
			number: 1,
			title: "Auth",
		});

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});

	test("each slice gets its own event; cursor advances to total count", () => {
		handleCreateSlice(db, root, milestoneId, "Auth");
		const result2 = handleCreateSlice(db, root, milestoneId, "DB");

		expect(result2.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(2);
		expect(events[0]?.cmd).toBe("create-slice");
		expect(events[1]?.cmd).toBe("create-slice");
		expect(events[1]?.params.title).toBe("DB");

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(2);
	});

	test("event id matches sliceId in DB", () => {
		const result = handleCreateSlice(db, root, milestoneId, "Auth");
		const sliceId = result.details.sliceId as string;
		const events = readEvents(root);
		expect(events[0]?.params.id).toBe(sliceId);

		const slices = getSlices(db, milestoneId);
		expect(must(slices[0]).id).toBe(sliceId);
	});
});
