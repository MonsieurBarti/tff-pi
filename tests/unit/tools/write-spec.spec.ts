import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	readArtifact,
} from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { handleWriteSpec } from "../../../src/tools/write-spec.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function createTempRoot(): string {
	return mkdtempSync(join(tmpdir(), "tff-write-spec-test-"));
}

describe("handleWriteSpec", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = createTestDb();
		root = createTempRoot();
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		initSliceDir(root, 1, 1);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes SPEC.md for a valid slice", () => {
		const content = "# Auth Spec\n\nDetails here.\n";
		const result = handleWriteSpec(db, root, sliceId, content, { headless: true });

		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("SPEC.md written for M01-S01");
		expect(result.details.path).toBe("milestones/M01/slices/M01-S01/SPEC.md");

		const written = readArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md");
		expect(written).toBe(content);
	});

	it("returns error for unknown slice", () => {
		const result = handleWriteSpec(db, root, "nonexistent", "content", { headless: true });

		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Slice not found");
	});
});
