import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../../src/common/db.js";
import { buildPreparationBrief } from "../../../src/common/preparation.js";

describe("preparation", () => {
	let root: string;
	let db: ReturnType<typeof openDatabase>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-prep-"));
		db = openDatabase(":memory:");
		applyMigrations(db);

		// Seed DB using raw SQL (actual table names are singular)
		db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(
			"p1",
			"TestProject",
			"A test project",
		);
		db.prepare(
			"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
		).run("m1", "p1", 1, "M1", "in_progress", "main");
		db.prepare(
			"INSERT INTO slice (id, milestone_id, number, title, status) VALUES (?, ?, ?, ?, ?)",
		).run("s1", "m1", 1, "Setup Auth", "discussing");
	});

	it("returns a PreparationBrief with all fields", async () => {
		const brief = buildPreparationBrief(
			root,
			db,
			{
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "Setup Auth",
				status: "discussing",
				tier: null,
				prUrl: null,
				createdAt: new Date().toISOString(),
			},
			1,
		);

		expect(brief).toHaveProperty("codebaseBrief");
		expect(brief).toHaveProperty("priorContext");
		expect(brief).toHaveProperty("relatedFiles");
		expect(brief).toHaveProperty("artifacts");
		expect(brief.artifacts).toHaveProperty("project");
		expect(brief.artifacts).toHaveProperty("requirements");
		expect(brief.artifacts).toHaveProperty("completedSpecs");
	});

	it("picks up PROJECT.md when present", async () => {
		const tffDir = join(root, ".pi", ".tff");
		mkdirSync(tffDir, { recursive: true });
		writeFileSync(join(tffDir, "PROJECT.md"), "# My Project\nVision here.");

		const brief = buildPreparationBrief(
			root,
			db,
			{
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "Setup Auth",
				status: "discussing",
				tier: null,
				prUrl: null,
				createdAt: "",
			},
			1,
		);

		expect(brief.artifacts.project).toContain("My Project");
	});

	it("picks up REQUIREMENTS.md from milestone dir", async () => {
		const mDir = join(root, ".pi", ".tff", "milestones", "M01");
		mkdirSync(mDir, { recursive: true });
		writeFileSync(join(mDir, "REQUIREMENTS.md"), "# Requirements\n- R01: Auth");

		const brief = buildPreparationBrief(
			root,
			db,
			{
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "Setup Auth",
				status: "discussing",
				tier: null,
				prUrl: null,
				createdAt: "",
			},
			1,
		);

		expect(brief.artifacts.requirements).toContain("R01: Auth");
	});

	it("detects tech stack from package.json", async () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "test", dependencies: { express: "^4.0.0", prisma: "^5.0.0" } }),
		);

		const brief = buildPreparationBrief(
			root,
			db,
			{
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "Setup Auth",
				status: "discussing",
				tier: null,
				prUrl: null,
				createdAt: "",
			},
			1,
		);

		expect(brief.codebaseBrief).toContain("express");
		expect(brief.codebaseBrief).toContain("prisma");
	});

	it("includes completed slice specs as prior context", async () => {
		// Add a completed slice
		db.prepare(
			"INSERT INTO slice (id, milestone_id, number, title, status, tier) VALUES (?, ?, ?, ?, ?, ?)",
		).run("s0", "m1", 0, "Prior Slice", "closed", "S");

		const specDir = join(root, ".pi", ".tff", "milestones", "M01", "slices", "M01-S00");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "SPEC.md"), "# Prior Slice Spec\nDesign decisions here.");

		const brief = buildPreparationBrief(
			root,
			db,
			{
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "Setup Auth",
				status: "discussing",
				tier: null,
				prUrl: null,
				createdAt: "",
			},
			1,
		);

		expect(brief.artifacts.completedSpecs.length).toBe(1);
		expect(brief.artifacts.completedSpecs[0]).toContain("Prior Slice Spec");
	});
});
