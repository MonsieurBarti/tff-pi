import { execFileSync, execSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { projectHomeDir } from "../../../src/common/project-home.js";
import {
	createWorktree,
	getWorktreePath,
	removeWorktree,
	worktreeExists,
} from "../../../src/common/worktree.js";

function initTestRepo(tffHome: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tff-wt-test-"));
	const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
	execFileSync("git", ["init", "--initial-branch", "main"], { cwd: dir, env });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, env });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, env });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, env });
	process.env.TFF_HOME = tffHome;
	handleInit(dir);
	execFileSync("git", ["commit", "-m", "tff init"], { cwd: dir, env });
	execFileSync("git", ["branch", "milestone/M01"], { cwd: dir, env });
	return dir;
}

describe("worktree", () => {
	let repoDir: string;
	let tffHomeDir: string;
	const savedTffHome = process.env.TFF_HOME;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save and clear GIT_* env vars to isolate from lefthook/worktree context
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		tffHomeDir = mkdtempSync(join(tmpdir(), "tff-wt-home-"));
		repoDir = initTestRepo(tffHomeDir);
	});

	afterEach(() => {
		// Clean up worktrees before removing the directory
		try {
			const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
			const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
				cwd: repoDir,
				encoding: "utf-8",
				env,
			});
			const worktreePaths = output
				.split("\n")
				.filter((l) => l.startsWith("worktree "))
				.map((l) => l.replace("worktree ", ""))
				.filter((p) => p !== repoDir);
			for (const p of worktreePaths) {
				execFileSync("git", ["worktree", "remove", p, "--force"], { cwd: repoDir, env });
			}
		} catch {
			// Ignore cleanup errors
		}
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(tffHomeDir, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		// Restore GIT_* env vars
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	describe("getWorktreePath", () => {
		it("returns the expected path", () => {
			const path = getWorktreePath(repoDir, "M01-S01");
			expect(path).toBe(join(repoDir, ".tff", "worktrees", "M01-S01"));
		});
	});

	describe("worktreeExists", () => {
		it("returns false when no worktree exists", () => {
			expect(worktreeExists(repoDir, "M01-S01")).toBe(false);
		});
	});

	describe("createWorktree", () => {
		it("creates a worktree and slice branch", () => {
			const wtPath = createWorktree(
				repoDir,
				"M01-S01",
				{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
				"milestone/M01",
			);
			expect(existsSync(wtPath)).toBe(true);
			expect(worktreeExists(repoDir, "M01-S01")).toBe(true);
		});

		it("returns existing worktree path if already created", () => {
			const first = createWorktree(
				repoDir,
				"M01-S01",
				{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
				"milestone/M01",
			);
			const second = createWorktree(
				repoDir,
				"M01-S01",
				{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
				"milestone/M01",
			);
			expect(first).toBe(second);
		});
	});

	describe("removeWorktree", () => {
		it("removes worktree and deletes slice branch", () => {
			createWorktree(
				repoDir,
				"M01-S01",
				{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
				"milestone/M01",
			);
			removeWorktree(repoDir, "M01-S01", { id: "deadbeef00000000aaaaaaaaaaaaaaaa" });
			expect(worktreeExists(repoDir, "M01-S01")).toBe(false);
			expect(existsSync(join(repoDir, ".tff", "worktrees", "M01-S01"))).toBe(false);
		});

		it("is a no-op if worktree does not exist", () => {
			expect(() =>
				removeWorktree(repoDir, "M01-S01", { id: "deadbeef00000000aaaaaaaaaaaaaaaa" }),
			).not.toThrow();
		});
	});
});

describe("createWorktree — M10-S01 inner symlink", () => {
	let repo: string;
	let home: string;
	const savedTffHome = process.env.TFF_HOME;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-wt-init-"));
		home = mkdtempSync(join(tmpdir(), "tff-wt-home-"));
		process.env.TFF_HOME = home;
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m init", { cwd: repo, stdio: "pipe" });
		handleInit(repo);
		// Commit the tracked files created by handleInit so worktree checkout sees them
		execSync("git commit -m 'tff init'", { cwd: repo, stdio: "pipe" });
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

	it("createWorktree creates .tff symlink inside the new worktree pointing to project home", () => {
		const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		const wtPath = createWorktree(
			repo,
			"M01-S01",
			{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
			mainBranch,
		);

		const innerLink = join(wtPath, ".tff");
		expect(lstatSync(innerLink).isSymbolicLink()).toBe(true);

		const projectId = readFileSync(join(repo, ".tff-project-id"), "utf-8").trim();
		expect(readlinkSync(innerLink)).toBe(projectHomeDir(projectId));
	});
});

describe("createWorktree — slice label validation (H1)", () => {
	let repo: string;
	let home: string;
	const savedTffHome = process.env.TFF_HOME;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-wt-h1-"));
		home = mkdtempSync(join(tmpdir(), "tff-wt-h1-home-"));
		process.env.TFF_HOME = home;
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m init", { cwd: repo, stdio: "pipe" });
		handleInit(repo);
		execSync("git commit -m 'tff init'", { cwd: repo, stdio: "pipe" });
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

	it("rejects path-traversal labels", () => {
		const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(() =>
			createWorktree(
				repo,
				"../../etc/passwd",
				{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
				mainBranch,
			),
		).toThrow(/Invalid slice label/);
	});

	it("rejects labels with shell metacharacters", () => {
		const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(() =>
			createWorktree(
				repo,
				"M01-S01; rm -rf /",
				{ id: "deadbeef00000000aaaaaaaaaaaaaaaa" },
				mainBranch,
			),
		).toThrow(/Invalid slice label/);
	});

	it("accepts canonical M##-S## labels", () => {
		const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(() =>
			createWorktree(repo, "M99-S88", { id: "deadbeef00000000aaaaaaaaaaaaaaaa" }, mainBranch),
		).not.toThrow();
	});
});
