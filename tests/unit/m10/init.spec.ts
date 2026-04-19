import { execSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { openDatabase } from "../../../src/common/db.js";
import { ProjectHomeError, isUuidV4 } from "../../../src/common/project-home.js";

describe("handleInit", () => {
	let repo: string;
	let home: string;
	const savedGitEnv: Record<string, string | undefined> = {};
	const savedTffHome = process.env.TFF_HOME;

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-init-repo-"));
		home = mkdtempSync(join(tmpdir(), "tff-init-home-"));
		process.env.TFF_HOME = home;
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("on a fresh repo: generates UUID, creates home, symlink, and .tff-project-id", () => {
		const result = handleInit(repo);
		expect(result.created).toBe(true);
		expect(isUuidV4(result.projectId)).toBe(true);
		expect(result.projectHome).toBe(join(home, result.projectId));
		expect(existsSync(join(home, result.projectId))).toBe(true);
		expect(existsSync(join(home, result.projectId, "milestones"))).toBe(true);
		expect(lstatSync(join(repo, ".pi", ".tff")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(repo, ".tff-project-id"), "utf-8").trim()).toBe(result.projectId);
	});

	it("on re-run: returns same projectId with created=false", () => {
		const first = handleInit(repo);
		const second = handleInit(repo);
		expect(second.projectId).toBe(first.projectId);
		expect(second.created).toBe(false);
	});

	it("throws ProjectHomeError when .tff/ is a real directory", () => {
		mkdirSync(join(repo, ".pi", ".tff"), { recursive: true });
		expect(() => handleInit(repo)).toThrow(ProjectHomeError);
	});

	it("throws ProjectHomeError when .tff-project-id is corrupt", () => {
		writeFileSync(join(repo, ".tff-project-id"), "garbage\n");
		expect(() => handleInit(repo)).toThrow(ProjectHomeError);
	});

	it("recovers when ~/.tff/{id}/ was deleted: re-creates home, keeps id", () => {
		const first = handleInit(repo);
		rmSync(first.projectHome, { recursive: true, force: true });
		rmSync(join(repo, ".pi", ".tff"));
		const second = handleInit(repo);
		expect(second.projectId).toBe(first.projectId);
		expect(second.created).toBe(false);
		expect(existsSync(first.projectHome)).toBe(true);
		expect(lstatSync(join(repo, ".pi", ".tff")).isSymbolicLink()).toBe(true);
	});

	it("throws on Windows", () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(() => handleInit(repo)).toThrow(/Windows support lands in M11/);
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		}
	});
});

describe("handleInit DB setup", () => {
	let repo: string;
	let home: string;
	const savedGitEnv: Record<string, string | undefined> = {};
	const savedTffHome = process.env.TFF_HOME;

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-init-db-repo-"));
		home = mkdtempSync(join(tmpdir(), "tff-init-db-home-"));
		process.env.TFF_HOME = home;
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("creates state.db at the project home with migrations applied", () => {
		const result = handleInit(repo);
		const dbPath = join(result.projectHome, "state.db");
		expect(existsSync(dbPath)).toBe(true);

		const db = openDatabase(dbPath);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		db.close();

		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("project");
		expect(tableNames).toContain("milestone");
		expect(tableNames).toContain("slice");
	});

	it("re-running handleInit does not destroy DB content", () => {
		const first = handleInit(repo);
		const dbPath = join(first.projectHome, "state.db");
		const db = openDatabase(dbPath);
		try {
			db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(
				"p-1",
				"Test",
				"Vision",
			);
		} finally {
			db.close();
		}

		handleInit(repo);

		const db2 = openDatabase(dbPath);
		let row: { name: string } | undefined;
		try {
			row = db2.prepare("SELECT name FROM project WHERE id = ?").get("p-1") as
				| { name: string }
				| undefined;
		} finally {
			db2.close();
		}
		expect(row?.name).toBe("Test");
	});
});

describe("handleInit git staging", () => {
	let repo: string;
	let home: string;
	const savedGitEnv: Record<string, string | undefined> = {};
	const savedTffHome = process.env.TFF_HOME;

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-init-stage-repo-"));
		home = mkdtempSync(join(tmpdir(), "tff-init-stage-home-"));
		process.env.TFF_HOME = home;
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	function stagedFiles(cwd: string): string[] {
		return execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" })
			.trim()
			.split("\n")
			.filter(Boolean);
	}

	it("fresh init stages .tff-project-id and .gitignore", () => {
		handleInit(repo);
		const staged = stagedFiles(repo);
		expect(staged).toContain(".tff-project-id");
		expect(staged).toContain(".gitignore");
	});

	it("init does not create any commit", () => {
		handleInit(repo);
		let log = "";
		try {
			log = execSync("git log --oneline", { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
		} catch {
			// fresh repo with no commits exits non-zero — that is the expected state
		}
		expect(log).toBe("");
	});

	it("re-running init after a commit stages nothing", () => {
		handleInit(repo);
		execSync("git commit -m 'init'", { cwd: repo, stdio: "pipe" });
		handleInit(repo);
		expect(stagedFiles(repo)).toEqual([]);
	});
});
