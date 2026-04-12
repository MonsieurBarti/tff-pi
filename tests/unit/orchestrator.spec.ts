import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTffDirectory, writeArtifact } from "../../src/common/artifacts.js";
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
	updateMilestoneStatus,
	updateSliceStatus,
	updateSliceTier,
} from "../../src/common/db.js";
import {
	buildPhasePrompt,
	collectPhaseContext,
	determineNextPhase,
	findActiveSlice,
	verifyPhaseArtifacts,
} from "../../src/orchestrator.js";
import { must } from "../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("findActiveSlice", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it("returns null when no project exists", () => {
		expect(findActiveSlice(db)).toBeNull();
	});

	it("returns null when no active milestone", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		expect(findActiveSlice(db)).toBeNull();
	});

	it("returns null when no active milestone (all closed)", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const m1Id = must(getMilestones(db, projectId)[0]).id;
		updateMilestoneStatus(db, m1Id, "closed");
		expect(findActiveSlice(db)).toBeNull();
	});

	it("returns first non-closed slice", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const s1Id = must(getSlices(db, milestoneId)[0]).id;
		updateSliceStatus(db, s1Id, "closed");

		const active = must(findActiveSlice(db));
		expect(active.title).toBe("DB");
	});
});

describe("determineNextPhase", () => {
	it("created -> discuss", () => {
		expect(determineNextPhase("created")).toBe("discuss");
	});

	it("discussing + SS -> research", () => {
		expect(determineNextPhase("discussing", "SS")).toBe("research");
	});

	it("discussing + SSS -> research", () => {
		expect(determineNextPhase("discussing", "SSS")).toBe("research");
	});

	it("discussing + S -> plan", () => {
		expect(determineNextPhase("discussing", "S")).toBe("plan");
	});

	it("discussing + null -> research", () => {
		expect(determineNextPhase("discussing", null)).toBe("research");
	});

	it("researching -> plan", () => {
		expect(determineNextPhase("researching")).toBe("plan");
	});

	it("planning -> execute", () => {
		expect(determineNextPhase("planning")).toBe("execute");
	});
	it("executing -> verify", () => {
		expect(determineNextPhase("executing")).toBe("verify");
	});
	it("verifying + SS -> review", () => {
		expect(determineNextPhase("verifying", "SS")).toBe("review");
	});
	it("verifying + S -> review (S only skips research; review required for all tiers)", () => {
		expect(determineNextPhase("verifying", "S")).toBe("review");
	});
	it("reviewing -> ship", () => {
		expect(determineNextPhase("reviewing")).toBe("ship");
	});
	it("shipping -> null", () => {
		expect(determineNextPhase("shipping")).toBeNull();
	});

	it("closed -> null", () => {
		expect(determineNextPhase("closed")).toBeNull();
	});
});

describe("collectPhaseContext", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-orch-test-"));
		initTffDirectory(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("includes PROJECT.md for discuss phase", () => {
		writeArtifact(root, "PROJECT.md", "# My Project");
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "created" as const,
			tier: null,
			prUrl: null,
			createdAt: "",
		};
		const ctx = collectPhaseContext(root, slice, 1, "discuss");
		expect(ctx["PROJECT.md"]).toBe("# My Project");
		expect(ctx["SPEC.md"]).toBeUndefined();
	});

	it("includes SPEC.md for research phase", () => {
		writeArtifact(root, "PROJECT.md", "# My Project");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "discussing" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const ctx = collectPhaseContext(root, slice, 1, "research");
		expect(ctx["SPEC.md"]).toBe("# Spec");
	});

	it("includes RESEARCH.md for plan phase", () => {
		writeArtifact(root, "PROJECT.md", "# My Project");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/RESEARCH.md", "# Research");
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "researching" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const ctx = collectPhaseContext(root, slice, 1, "plan");
		expect(ctx["SPEC.md"]).toBe("# Spec");
		expect(ctx["RESEARCH.md"]).toBe("# Research");
	});
});

describe("buildPhasePrompt", () => {
	it("produces a SubAgentPrompt with correct label", () => {
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "created" as const,
			tier: null,
			prUrl: null,
			createdAt: "",
		};
		const context = { "PROJECT.md": "# Project" };
		const prompt = buildPhasePrompt(slice, 1, "discuss", context, false);
		expect(prompt.label).toBe("discuss:M01-S01");
		expect(prompt.tools).toContain("tff_classify");
		expect(prompt.tools).toContain("tff_write_spec");
		expect(prompt.userPrompt).toContain("Auth");
		expect(prompt.userPrompt).toContain("s1");
	});

	it("adds compression instruction when compressed", () => {
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "created" as const,
			tier: null,
			prUrl: null,
			createdAt: "",
		};
		const longContent = "x".repeat(5000);
		const context = { "PROJECT.md": longContent };
		const prompt = buildPhasePrompt(slice, 1, "discuss", context, true);
		// Full content is preserved
		expect(prompt.userPrompt).toContain(longContent);
		// Compression instruction is appended
		expect(prompt.userPrompt).toContain("compressed R1-R10 notation");
	});

	it("does not add compression instruction when not compressed", () => {
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "created" as const,
			tier: null,
			prUrl: null,
			createdAt: "",
		};
		const context = { "PROJECT.md": "# Project" };
		const prompt = buildPhasePrompt(slice, 1, "discuss", context, false);
		expect(prompt.userPrompt).not.toContain("compressed R1-R10 notation");
	});
});

describe("verifyPhaseArtifacts", () => {
	let root: string;
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-verify-test-"));
		initTffDirectory(root);
		db = createTestDb();
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reports missing SPEC.md, REQUIREMENTS.md, and tier for discuss phase", () => {
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "discussing" as const,
			tier: null,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "discuss");
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("SPEC.md");
		expect(result.missing).toContain("REQUIREMENTS.md");
		expect(result.missing).toContain("tier classification");
	});

	it("passes discuss phase when SPEC.md, REQUIREMENTS.md, and tier exist", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Requirements");
		updateSliceTier(db, sliceId, "SS");
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "discussing" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "discuss");
		expect(result.ok).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("reports missing RESEARCH.md for SSS research phase", () => {
		updateSliceTier(db, sliceId, "SSS");
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "researching" as const,
			tier: "SSS" as const,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "research");
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("RESEARCH.md (required for SSS)");
	});

	it("passes research phase for SS tier without RESEARCH.md", () => {
		updateSliceTier(db, sliceId, "SS");
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "researching" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "research");
		expect(result.ok).toBe(true);
	});

	it("reports missing PLAN.md for plan phase", () => {
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "planning" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "plan");
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("PLAN.md");
	});

	it("passes plan phase when PLAN.md exists and tasks persisted", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
		insertTask(db, { sliceId, number: 1, title: "Foo", wave: 1 });
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "planning" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "plan");
		expect(result.ok).toBe(true);
	});

	it("fails plan phase when PLAN.md exists but no tasks persisted", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan");
		const slice = {
			id: sliceId,
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "planning" as const,
			tier: "SS" as const,
			prUrl: null,
			createdAt: "",
		};
		const result = verifyPhaseArtifacts(db, root, slice, 1, "plan");
		expect(result.ok).toBe(false);
		expect(result.missing.some((m) => m.includes("tasks"))).toBe(true);
	});
});
