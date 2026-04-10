import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWorktree,
	getWorktreePath,
	removeWorktree,
	worktreeExists,
} from "../../../src/common/worktree.js";

function initTestRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "tff-wt-test-"));
	const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
	execFileSync("git", ["init", "--initial-branch", "main"], { cwd: dir, env });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, env });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, env });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, env });
	execFileSync("git", ["branch", "milestone/M01"], { cwd: dir, env });
	return dir;
}

describe("worktree", () => {
	let repoDir: string;

	beforeEach(() => {
		repoDir = initTestRepo();
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
			const wtPath = createWorktree(repoDir, "M01-S01", "milestone/M01");
			expect(existsSync(wtPath)).toBe(true);
			expect(worktreeExists(repoDir, "M01-S01")).toBe(true);
		});

		it("returns existing worktree path if already created", () => {
			const first = createWorktree(repoDir, "M01-S01", "milestone/M01");
			const second = createWorktree(repoDir, "M01-S01", "milestone/M01");
			expect(first).toBe(second);
		});
	});

	describe("removeWorktree", () => {
		it("removes worktree and deletes slice branch", () => {
			createWorktree(repoDir, "M01-S01", "milestone/M01");
			removeWorktree(repoDir, "M01-S01");
			expect(worktreeExists(repoDir, "M01-S01")).toBe(false);
			expect(existsSync(join(repoDir, ".tff", "worktrees", "M01-S01"))).toBe(false);
		});

		it("is a no-op if worktree does not exist", () => {
			expect(() => removeWorktree(repoDir, "M01-S01")).not.toThrow();
		});
	});
});
