import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { readArtifact } from "../../../src/common/artifacts.js";
import { compressIfEnabled } from "../../../src/common/compress.js";
import { applyMigrations, getProject, openDatabase } from "../../../src/common/db.js";
import { handleCreateProject } from "../../../src/tools/create-project.js";
import { must } from "../../helpers.js";

vi.mock("../../../src/common/compress.js", () => ({
	compressIfEnabled: vi.fn((input: string) => input),
}));

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleCreateProject", () => {
	let db: Database.Database;
	let root: string;
	let tffHome: string;
	let savedTffHome: string | undefined;

	beforeEach(() => {
		savedTffHome = process.env.TFF_HOME;
		tffHome = mkdtempSync(join(tmpdir(), "tff-home-create-test-"));
		process.env.TFF_HOME = tffHome;
		db = createTestDb();
		root = mkdtempSync(join(tmpdir(), "tff-create-test-"));
		execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
		handleInit(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(tffHome, { recursive: true, force: true });
		if (savedTffHome !== undefined) process.env.TFF_HOME = savedTffHome;
		else process.env.TFF_HOME = undefined;
	});

	it("creates a project and returns success", () => {
		const result = handleCreateProject(db, root, {
			projectName: "TFF",
			vision: "Build great things",
		});

		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("TFF");
		expect(must(result.content[0]).text).toContain("Use /tff new-milestone");
		expect(result.details.projectId).toBeDefined();

		const project = must(getProject(db));
		expect(project.name).toBe("TFF");
	});

	it("returns error when project already exists", () => {
		handleCreateProject(db, root, {
			projectName: "TFF",
			vision: "Vision",
		});

		const result = handleCreateProject(db, root, {
			projectName: "TFF2",
			vision: "Vision 2",
		});

		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Project already exists");
	});

	it("compresses content when enabled", () => {
		vi.mocked(compressIfEnabled).mockReturnValueOnce("[COMPRESSED]project");
		handleCreateProject(db, root, { projectName: "TFF", vision: "V" });
		const written = readArtifact(root, "PROJECT.md");
		expect(written).toBe("[COMPRESSED]project");
	});
});
