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
	openDatabase,
	updateMilestoneStatus,
	updateSliceStatus,
} from "../../src/common/db.js";
import {
	buildPhasePrompt,
	collectPhaseContext,
	determineNextPhase,
	findActiveSlice,
} from "../../src/orchestrator.js";

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
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const m1Id = getMilestones(db, projectId)[0]!.id;
		updateMilestoneStatus(db, m1Id, "closed");
		expect(findActiveSlice(db)).toBeNull();
	});

	it("returns first non-closed slice", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const s1Id = getSlices(db, milestoneId)[0]!.id;
		updateSliceStatus(db, s1Id, "closed");

		const active = findActiveSlice(db);
		expect(active).not.toBeNull();
		expect(active!.title).toBe("DB");
	});

	it("skips paused slices", () => {
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = getProject(db)!.id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = getMilestones(db, projectId)[0]!.id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const s1Id = getSlices(db, milestoneId)[0]!.id;
		updateSliceStatus(db, s1Id, "paused");

		const active = findActiveSlice(db);
		expect(active).not.toBeNull();
		expect(active!.title).toBe("DB");
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

	it("planning -> null", () => {
		expect(determineNextPhase("planning")).toBeNull();
	});

	it("executing -> null", () => {
		expect(determineNextPhase("executing")).toBeNull();
	});

	it("closed -> null", () => {
		expect(determineNextPhase("closed")).toBeNull();
	});

	it("paused -> null", () => {
		expect(determineNextPhase("paused")).toBeNull();
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

	it("truncates context when compressed", () => {
		const slice = {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Auth",
			status: "created" as const,
			tier: null,
			createdAt: "",
		};
		const longContent = "x".repeat(5000);
		const context = { "PROJECT.md": longContent };
		const prompt = buildPhasePrompt(slice, 1, "discuss", context, true);
		// compressed truncates to 2000 chars
		expect(prompt.userPrompt.length).toBeLessThan(longContent.length);
	});
});
