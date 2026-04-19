import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { handleClassify } from "../../../src/tools/classify.js";

describe("handleClassify — event log", () => {
	test("appends classify event, sets tier, advances cursor", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-classify-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(sId);
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\n");

		const result = handleClassify(db, root, sId, "SS");
		expect(result.isError).toBeFalsy();
		expect(getSlice(db, sId)?.tier).toBe("SS");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("classify");

		expect(loadCursor(db).lastRow).toBe(1);
	});
});
