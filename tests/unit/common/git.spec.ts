import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	branchExists,
	createBranch,
	getCurrentBranch,
	getDefaultBranch,
	getGitRoot,
	initRepo,
} from "../../../src/common/git.js";
import { must } from "../../helpers.js";

describe("git", () => {
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

		repoDir = mkdtempSync(join(tmpdir(), "tff-git-test-"));
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

	describe("getGitRoot", () => {
		it("returns the git root for a repo directory", () => {
			const root = getGitRoot(repoDir);
			expect(root).not.toBeNull();
			expect(root).toContain("tff-git-test-");
		});

		it("returns null for a non-git directory", () => {
			const nonGitDir = mkdtempSync(join(tmpdir(), "tff-nongit-"));
			try {
				expect(getGitRoot(nonGitDir)).toBeNull();
			} finally {
				rmSync(nonGitDir, { recursive: true, force: true });
			}
		});
	});

	describe("getCurrentBranch", () => {
		it("returns the current branch name", () => {
			const branch = getCurrentBranch(repoDir);
			expect(branch).not.toBeNull();
			expect(typeof branch).toBe("string");
		});
	});

	describe("branchExists", () => {
		it("returns true for an existing branch", () => {
			const branch = must(getCurrentBranch(repoDir));
			expect(branchExists(branch, repoDir)).toBe(true);
		});

		it("returns false for a non-existing branch", () => {
			expect(branchExists("nonexistent-branch-xyz", repoDir)).toBe(false);
		});

		it("is safe against shell metacharacters", () => {
			expect(branchExists("; echo pwned", repoDir)).toBe(false);
		});
	});

	describe("createBranch", () => {
		it("creates a new branch from the current HEAD", () => {
			const head = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
			createBranch("test-branch", head, repoDir);
			expect(branchExists("test-branch", repoDir)).toBe(true);
		});

		it("throws when creating a branch that already exists", () => {
			const head = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
			createBranch("dup-branch", head, repoDir);
			expect(() => createBranch("dup-branch", head, repoDir)).toThrow();
		});
	});

	describe("initRepo", () => {
		it("initializes a git repository in a non-git directory", () => {
			const nonGitDir = mkdtempSync(join(tmpdir(), "tff-initrepo-"));
			try {
				expect(getGitRoot(nonGitDir)).toBeNull();
				initRepo(nonGitDir);
				expect(getGitRoot(nonGitDir)).not.toBeNull();
			} finally {
				rmSync(nonGitDir, { recursive: true, force: true });
			}
		});

		it("is idempotent — does not throw on existing repo", () => {
			expect(() => initRepo(repoDir)).not.toThrow();
		});
	});

	describe("getDefaultBranch", () => {
		it("returns null for a repo without remote", () => {
			// repoDir has no remote, so getDefaultBranch should return null
			const branch = getDefaultBranch(repoDir);
			expect(branch).toBeNull();
		});

		it("returns null for non-git directory", () => {
			const nonGitDir = mkdtempSync(join(tmpdir(), "tff-nodefault-"));
			try {
				expect(getDefaultBranch(nonGitDir)).toBeNull();
			} finally {
				rmSync(nonGitDir, { recursive: true, force: true });
			}
		});
	});
});
