import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleNew } from "../../../src/commands/new.js";
import { artifactExists, readArtifact } from "../../../src/common/artifacts.js";
import { applyMigrations, getMilestones, getProject, getSlices } from "../../../src/common/db.js";

function createTestDb(): Database.Database {
	const db = new Database(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleNew", () => {
	let db: Database.Database;
	let root: string;

	beforeEach(() => {
		db = createTestDb();
		root = mkdtempSync(join(tmpdir(), "tff-new-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a project with name and vision", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth", "DB"],
		});

		const project = getProject(db);
		expect(project).not.toBeNull();
		expect(project!.name).toBe("TFF");
		expect(project!.vision).toBe("Make coding great");
	});

	it("creates a milestone linked to the project", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth", "DB"],
		});

		const project = getProject(db);
		const milestones = getMilestones(db, project!.id);
		expect(milestones).toHaveLength(1);
		expect(milestones[0]!.name).toBe("Foundation");
		expect(milestones[0]!.number).toBe(1);
		expect(milestones[0]!.branch).toBe("milestone/M01");
		expect(milestones[0]!.projectId).toBe(project!.id);
	});

	it("creates slices within the milestone", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth", "DB", "API"],
		});

		const project = getProject(db);
		const milestones = getMilestones(db, project!.id);
		const slices = getSlices(db, milestones[0]!.id);
		expect(slices).toHaveLength(3);
		expect(slices[0]!.title).toBe("Auth");
		expect(slices[0]!.number).toBe(1);
		expect(slices[1]!.title).toBe("DB");
		expect(slices[1]!.number).toBe(2);
		expect(slices[2]!.title).toBe("API");
		expect(slices[2]!.number).toBe(3);
	});

	it("writes PROJECT.md artifact", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth"],
		});

		expect(artifactExists(root, "PROJECT.md")).toBe(true);
		const content = readArtifact(root, "PROJECT.md");
		expect(content).toContain("TFF");
		expect(content).toContain("Make coding great");
	});

	it("writes REQUIREMENTS.md artifact for milestone", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth"],
		});

		expect(artifactExists(root, "milestones/M01/REQUIREMENTS.md")).toBe(true);
	});

	it("creates slice directories with .keep files", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth", "DB"],
		});

		expect(existsSync(join(root, ".tff", "milestones", "M01", "slices", "M01-S01"))).toBe(true);
		expect(existsSync(join(root, ".tff", "milestones", "M01", "slices", "M01-S02"))).toBe(true);
		expect(artifactExists(root, "milestones/M01/slices/M01-S01/.keep")).toBe(true);
		expect(artifactExists(root, "milestones/M01/slices/M01-S02/.keep")).toBe(true);
	});

	it("returns projectId and milestoneId", () => {
		const result = handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth"],
		});

		expect(result.projectId).toBeDefined();
		expect(result.milestoneId).toBeDefined();
		expect(typeof result.projectId).toBe("string");
		expect(typeof result.milestoneId).toBe("string");
	});

	it("throws if project already exists", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
			milestoneName: "Foundation",
			slices: ["Auth"],
		});

		expect(() =>
			handleNew(db, root, {
				projectName: "TFF",
				vision: "Another vision",
				milestoneName: "Second",
				slices: ["Slice"],
			}),
		).toThrow("Project already exists. Use /tff new-milestone to add milestones.");
	});
});
