import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMilestone } from "../../../src/commands/new-milestone.js";
import {
	artifactExists,
	initTffDirectory,
	milestoneDir,
	readArtifact,
} from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	insertProject,
	openDatabase,
} from "../../../src/common/db.js";
import { branchExists } from "../../../src/common/git.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("createMilestone", () => {
	let db: Database.Database;
	let root: string;
	let projectId: string;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save and clear GIT_* env vars to isolate from lefthook/worktree context
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		db = createTestDb();
		root = mkdtempSync(join(tmpdir(), "tff-milestone-test-"));

		// Init git repo — createMilestone requires one
		execSync("git init", { cwd: root, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: root, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: root, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'init'", { cwd: root, stdio: "pipe" });

		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		projectId = must(getProject(db)).id;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("creates M01 milestone", () => {
		const result = createMilestone(db, root, projectId, "Foundation");
		expect(result.number).toBe(1);
		expect(result.branch).toBe("milestone/M01");
		expect(result.milestoneId).toBeDefined();

		const milestones = getMilestones(db, projectId);
		expect(milestones).toHaveLength(1);
		expect(must(milestones[0]).name).toBe("Foundation");
		expect(must(milestones[0]).status).toBe("created");
	});

	it("auto-increments to M02", () => {
		createMilestone(db, root, projectId, "Foundation");
		const result = createMilestone(db, root, projectId, "Core Features");
		expect(result.number).toBe(2);
		expect(result.branch).toBe("milestone/M02");

		const milestones = getMilestones(db, projectId);
		expect(milestones).toHaveLength(2);
	});

	it("creates milestone directory on disk", () => {
		createMilestone(db, root, projectId, "Foundation");
		const dir = milestoneDir(root, 1);
		expect(existsSync(dir)).toBe(true);
	});

	it("writes REQUIREMENTS.md artifact", () => {
		createMilestone(db, root, projectId, "Foundation");
		expect(artifactExists(root, "milestones/M01/REQUIREMENTS.md")).toBe(true);
		const content = readArtifact(root, "milestones/M01/REQUIREMENTS.md");
		expect(content).toContain("Foundation");
		expect(content).toContain("Requirements");
	});

	it("creates milestone/M01 git branch", () => {
		createMilestone(db, root, projectId, "Foundation");
		expect(branchExists("milestone/M01", root)).toBe(true);
	});

	it("creates separate branches for each milestone", () => {
		createMilestone(db, root, projectId, "Foundation");
		createMilestone(db, root, projectId, "Core");
		expect(branchExists("milestone/M01", root)).toBe(true);
		expect(branchExists("milestone/M02", root)).toBe(true);
	});
});
