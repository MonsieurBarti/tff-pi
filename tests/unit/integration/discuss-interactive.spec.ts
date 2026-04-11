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
import { isGateUnlocked, resetGates, unlockGate } from "../../../src/common/discuss-gates.js";
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
		initSliceDir(root, 1, 1);

		resetGates(sliceId);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("write-spec gate flow", () => {
		it("locked -> unlock -> write succeeds", () => {
			// Step 1: write-spec is blocked
			const blocked = handleWriteSpec(db, root, sliceId, "# Spec");
			expect(blocked.isError).toBe(true);
			expect(must(blocked.content[0]).text).toContain("Depth verification required");

			// Step 2: unlock gate
			unlockGate(sliceId, "depth_verified");
			expect(isGateUnlocked(sliceId, "depth_verified")).toBe(true);

			// Step 3: write-spec succeeds
			const success = handleWriteSpec(db, root, sliceId, "# Spec Content");
			expect(success.isError).toBeUndefined();
			expect(must(success.content[0]).text).toContain("SPEC.md written");
		});
	});

	describe("classify gate flow", () => {
		it("locked -> unlock -> classify succeeds", () => {
			const blocked = handleClassify(db, sliceId, "SS");
			expect(blocked.isError).toBe(true);
			expect(must(blocked.content[0]).text).toContain("Tier must be confirmed");

			unlockGate(sliceId, "tier_confirmed");

			const success = handleClassify(db, sliceId, "SS");
			expect(success.isError).toBeUndefined();
			expect(must(success.content[0]).text).toContain("classified as Tier SS");
		});
	});

	describe("gate isolation", () => {
		it("gates are per-slice -- unlocking one slice doesn't affect another", () => {
			// Add second slice
			const milestoneId = must(getMilestones(db, must(getProject(db)).id)[0]).id;
			insertSlice(db, { milestoneId, number: 2, title: "Other Slice" });
			const s2Id = must(getSlices(db, milestoneId)[1]).id;
			resetGates(s2Id);

			unlockGate(sliceId, "depth_verified");
			expect(isGateUnlocked(sliceId, "depth_verified")).toBe(true);
			expect(isGateUnlocked(s2Id, "depth_verified")).toBe(false);
		});
	});

	describe("gate reset", () => {
		it("resetGates clears all gates for a slice", () => {
			unlockGate(sliceId, "depth_verified");
			unlockGate(sliceId, "tier_confirmed");
			expect(isGateUnlocked(sliceId, "depth_verified")).toBe(true);
			expect(isGateUnlocked(sliceId, "tier_confirmed")).toBe(true);

			resetGates(sliceId);
			expect(isGateUnlocked(sliceId, "depth_verified")).toBe(false);
			expect(isGateUnlocked(sliceId, "tier_confirmed")).toBe(false);
		});
	});

	describe("gates always enforced", () => {
		it("write-spec always requires gate", () => {
			const result = handleWriteSpec(db, root, sliceId, "# Spec");
			expect(result.isError).toBe(true);
			expect(must(result.content[0]).text).toContain("Depth verification required");
		});

		it("classify always requires gate", () => {
			const result = handleClassify(db, sliceId, "SSS");
			expect(result.isError).toBe(true);
			expect(must(result.content[0]).text).toContain("Tier must be confirmed");
		});
	});
});
