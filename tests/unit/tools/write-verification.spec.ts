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
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { handleWriteVerification } from "../../../src/tools/write-verification.js";
import { must } from "../../helpers.js";

describe("handleWriteVerification", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-write-verif-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'verifying' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "verify",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		initSliceDir(root, 1, 1);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes VERIFICATION.md", () => {
		const result = handleWriteVerification(db, root, sliceId, "# Verify\n- [x] AC-1 passes");
		expect(result.isError).toBeUndefined();
		expect(readArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md")).toContain("AC-1");
	});

	it("errors on unknown slice", () => {
		const result = handleWriteVerification(db, root, "nonexistent", "# x");
		expect(result.isError).toBe(true);
	});
});
