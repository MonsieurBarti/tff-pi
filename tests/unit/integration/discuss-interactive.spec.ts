import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	writeArtifact,
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
import { handleClassify } from "../../../src/tools/classify.js";
import { handleWriteSpec } from "../../../src/tools/write-spec.js";
import { must } from "../../helpers.js";

describe("discuss interactive integration", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-int-"));
		db = openDatabase(":memory:");
		applyMigrations(db);

		initTffDirectory(root);

		insertProject(db, { name: "Test", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "main" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth System" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(sliceId);
		initSliceDir(root, 1, 1);
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("write-spec flow", () => {
		it("write-spec succeeds without any gate", () => {
			const result = handleWriteSpec(db, root, sliceId, "# Spec Content");
			expect(result.isError).toBeUndefined();
			expect(must(result.content[0]).text).toContain("SPEC.md written");
		});
	});

	describe("classify flow", () => {
		it("classify succeeds without any gate", () => {
			const result = handleClassify(db, root, sliceId, "SS");
			expect(result.isError).toBeUndefined();
			expect(must(result.content[0]).text).toContain("classified as Tier SS");
		});
	});

	describe("slice isolation", () => {
		it("classify on one slice does not affect another", () => {
			// Add second slice
			const milestoneId = must(getMilestones(db, must(getProject(db)).id)[0]).id;
			insertSlice(db, { milestoneId, number: 2, title: "Other Slice" });
			const s2Id = must(getSlices(db, milestoneId)[1]).id;
			db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(s2Id);
			initSliceDir(root, 1, 2);
			writeArtifact(root, "milestones/M01/slices/M01-S02/SPEC.md", "# Spec 2\n");

			const r1 = handleClassify(db, root, sliceId, "SS");
			expect(r1.isError).toBeUndefined();

			// Second slice not classified — classify it independently
			const r2 = handleClassify(db, root, s2Id, "SSS");
			expect(r2.isError).toBeUndefined();
			expect(must(r2.content[0]).text).toContain("classified as Tier SSS");
		});
	});
});
