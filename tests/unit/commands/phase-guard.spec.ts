import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPhasePreconditions } from "../../../src/commands/phase-guard.js";
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
	insertTask,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

describe("assertPhasePreconditions", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-guard-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		initSliceDir(root, 1, 1);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("no-op when projectRoot is null (test-friendly)", () => {
		const result = assertPhasePreconditions(db, null, sliceId, "execute");
		expect(result.valid).toBe(true);
	});

	it("allows discuss regardless of prior state", () => {
		const result = assertPhasePreconditions(db, root, sliceId, "discuss");
		expect(result.valid).toBe(true);
	});

	it("blocks execute when PLAN.md missing", () => {
		const result = assertPhasePreconditions(db, root, sliceId, "execute");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/plan/i);
		expect(result.error).toMatch(/PLAN\.md/);
	});

	it("blocks execute when PLAN.md exists but no tasks persisted", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan\n");
		const result = assertPhasePreconditions(db, root, sliceId, "execute");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/tasks persisted/);
	});

	it("allows execute when PLAN.md and ≥1 task with wave exist", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan\n");
		insertTask(db, { sliceId, number: 1, title: "Foo", wave: 1 });
		const result = assertPhasePreconditions(db, root, sliceId, "execute");
		expect(result.valid).toBe(true);
	});

	it("blocks plan (non-S tier) when RESEARCH.md missing", () => {
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Req");
		// Predecessor is research because non-S; verifyPhaseArtifacts('discuss') would pass,
		// but research only requires RESEARCH.md for SSS tier → SS tier allows it.
		const result = assertPhasePreconditions(db, root, sliceId, "plan");
		expect(result.valid).toBe(true);
	});

	it("blocks plan (SSS tier) when RESEARCH.md missing", () => {
		updateSliceTier(db, sliceId, "SSS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Req");
		const result = assertPhasePreconditions(db, root, sliceId, "plan");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/RESEARCH\.md/);
	});

	it("blocks ship (S tier) when REVIEW.md missing — S only skips research", () => {
		updateSliceTier(db, sliceId, "S");
		writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# Verify");
		const result = assertPhasePreconditions(db, root, sliceId, "ship");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/REVIEW\.md/);
	});

	it("allows ship when REVIEW.md exists (any tier)", () => {
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md", "# Review");
		const result = assertPhasePreconditions(db, root, sliceId, "ship");
		expect(result.valid).toBe(true);
	});
});
