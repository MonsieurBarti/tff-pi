import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addRemote,
	createGitignore,
	hasRemote,
	initialCommitAndPush,
} from "../../../src/common/git.js";

describe("git-setup", () => {
	let repoDir: string;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save and clear GIT_* env vars to isolate from lefthook/worktree context
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		repoDir = mkdtempSync(join(tmpdir(), "tff-git-setup-"));
		execSync("git init", { cwd: repoDir, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'init'", { cwd: repoDir, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		// Restore GIT_* env vars
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	describe("createGitignore", () => {
		it("creates a new .gitignore with default entries", () => {
			createGitignore(repoDir);
			const content = readFileSync(join(repoDir, ".gitignore"), "utf-8");
			expect(content).toContain("/.tff");
			expect(content).toContain(".pi/");
			expect(content).toContain("node_modules/");
			expect(content).toContain("dist/");
			expect(content).toContain(".DS_Store");
			expect(content).toContain("*.log");
			expect(content).toContain(".env");
			expect(content).toContain(".env.*");
			expect(content).toContain("coverage/");
		});

		it("appends missing entries to an existing .gitignore without duplicates", () => {
			writeFileSync(join(repoDir, ".gitignore"), "node_modules/\ncustom-entry\n");
			createGitignore(repoDir);
			const content = readFileSync(join(repoDir, ".gitignore"), "utf-8");
			// Original entries preserved
			expect(content).toContain("custom-entry");
			// New defaults added
			expect(content).toContain("/.tff");
			expect(content).toContain(".pi/");
			// No duplicate node_modules/
			const matches = content.split("\n").filter((l) => l === "node_modules/");
			expect(matches).toHaveLength(1);
		});

		it("is idempotent — running twice produces same result", () => {
			createGitignore(repoDir);
			const first = readFileSync(join(repoDir, ".gitignore"), "utf-8");
			createGitignore(repoDir);
			const second = readFileSync(join(repoDir, ".gitignore"), "utf-8");
			expect(first).toBe(second);
		});
	});

	describe("hasRemote", () => {
		it("returns false when no remote is configured", () => {
			expect(hasRemote(repoDir)).toBe(false);
		});

		it("returns true after adding a remote", () => {
			execSync("git remote add origin https://example.com/repo.git", {
				cwd: repoDir,
				stdio: "pipe",
			});
			expect(hasRemote(repoDir)).toBe(true);
		});
	});

	describe("addRemote", () => {
		it("adds origin remote", () => {
			addRemote("https://example.com/repo.git", repoDir);
			const remotes = execSync("git remote -v", {
				cwd: repoDir,
				encoding: "utf-8",
				stdio: "pipe",
			});
			expect(remotes).toContain("origin");
			expect(remotes).toContain("https://example.com/repo.git");
		});

		it("throws if remote already exists", () => {
			addRemote("https://example.com/repo.git", repoDir);
			expect(() => addRemote("https://example.com/other.git", repoDir)).toThrow();
		});
	});

	describe("initialCommitAndPush", () => {
		let bareDir: string;

		beforeEach(() => {
			// Create a bare remote repo to push to
			bareDir = mkdtempSync(join(tmpdir(), "tff-bare-"));
			execSync("git init --bare", { cwd: bareDir, stdio: "pipe" });
			execSync(`git remote add origin ${bareDir}`, { cwd: repoDir, stdio: "pipe" });
		});

		afterEach(() => {
			rmSync(bareDir, { recursive: true, force: true });
		});

		it("creates a commit containing .gitignore and pushes to remote", () => {
			createGitignore(repoDir);
			initialCommitAndPush(repoDir);

			// Verify the commit exists
			const log = execSync("git log --oneline -1", {
				cwd: repoDir,
				encoding: "utf-8",
				stdio: "pipe",
			});
			expect(log).toContain("chore: initial commit");

			// Verify .gitignore is in the commit
			const files = execSync("git show --name-only --format='' HEAD", {
				cwd: repoDir,
				encoding: "utf-8",
				stdio: "pipe",
			});
			expect(files).toContain(".gitignore");

			// Verify push happened — bare repo has the commit
			const bareLog = execSync("git log --oneline -1", {
				cwd: bareDir,
				encoding: "utf-8",
				stdio: "pipe",
			});
			expect(bareLog).toContain("chore: initial commit");
		});
	});
});
