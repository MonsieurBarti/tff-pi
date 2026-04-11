import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initMilestoneDir, initSliceDir, initTffDirectory } from "../../../src/common/artifacts.js";
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
import { resetGates, unlockGate } from "../../../src/common/discuss-gates.js";
import { handleWriteSpec } from "../../../src/tools/write-spec.js";
import { must } from "../../helpers.js";

describe("write-spec gate", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-test-"));
		db = openDatabase(":memory:");
		applyMigrations(db);
		initTffDirectory(root);

		insertProject(db, { name: "Test", vision: "Test vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "main" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Test Slice" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		initSliceDir(root, 1, 1);

		resetGates(sliceId);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects write when depth_verified gate is locked", () => {
		const result = handleWriteSpec(db, root, sliceId, "# Spec");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Depth verification required");
	});

	it("allows write when depth_verified gate is unlocked", () => {
		unlockGate(sliceId, "depth_verified");
		const result = handleWriteSpec(db, root, sliceId, "# Spec");
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("SPEC.md written");
	});

	it("enforces gate always (no headless bypass)", () => {
		const result = handleWriteSpec(db, root, sliceId, "# Spec");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Depth verification required");
	});
});
