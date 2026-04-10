import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleNew } from "../../../src/commands/new.js";
import { artifactExists, readArtifact } from "../../../src/common/artifacts.js";
import { applyMigrations, getMilestones, getProject } from "../../../src/common/db.js";

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
		});

		const project = getProject(db);
		expect(project).not.toBeNull();
		expect(project!.name).toBe("TFF");
		expect(project!.vision).toBe("Make coding great");
	});

	it("writes PROJECT.md artifact", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		expect(artifactExists(root, "PROJECT.md")).toBe(true);
		const content = readArtifact(root, "PROJECT.md");
		expect(content).toContain("TFF");
		expect(content).toContain("Make coding great");
	});

	it("does NOT create milestones", () => {
		const result = handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		const project = getProject(db);
		const milestones = getMilestones(db, project!.id);
		expect(milestones).toHaveLength(0);
		expect(result.projectId).toBeDefined();
		expect(typeof result.projectId).toBe("string");
	});

	it("returns projectId", () => {
		const result = handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		expect(result.projectId).toBeDefined();
		expect(typeof result.projectId).toBe("string");
	});

	it("throws if project already exists", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		expect(() =>
			handleNew(db, root, {
				projectName: "TFF",
				vision: "Another vision",
			}),
		).toThrow("Project already exists. Use /tff new-milestone to add milestones.");
	});
});
