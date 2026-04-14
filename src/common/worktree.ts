import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCheckpoint } from "./checkpoint.js";
import { gitEnv } from "./git.js";

export function getWorktreePath(root: string, sliceLabel: string): string {
	return join(root, ".tff", "worktrees", sliceLabel);
}

export function worktreeExists(root: string, sliceLabel: string): boolean {
	const wtPath = getWorktreePath(root, sliceLabel);
	if (!existsSync(wtPath)) return false;
	try {
		const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
			cwd: root,
			encoding: "utf-8",
			env: gitEnv(),
		});
		return output.includes(wtPath);
	} catch {
		return false;
	}
}

export function createWorktree(root: string, sliceLabel: string, milestoneBranch: string): string {
	const wtPath = getWorktreePath(root, sliceLabel);
	if (worktreeExists(root, sliceLabel)) {
		return wtPath;
	}

	mkdirSync(join(root, ".tff", "worktrees"), { recursive: true });

	const branchName = `slice/${sliceLabel}`;
	const env = gitEnv();

	let branchExists = false;
	try {
		execFileSync("git", ["rev-parse", "--verify", branchName], {
			cwd: root,
			encoding: "utf-8",
			stdio: "pipe",
			env,
		});
		branchExists = true;
	} catch {
		// Branch does not exist
	}

	if (branchExists) {
		execFileSync("git", ["worktree", "add", wtPath, branchName], {
			cwd: root,
			encoding: "utf-8",
			env,
		});
	} else {
		execFileSync("git", ["worktree", "add", wtPath, "-b", branchName, milestoneBranch], {
			cwd: root,
			encoding: "utf-8",
			env,
		});
	}

	return wtPath;
}

/**
 * Idempotent: creates the git worktree + pre-execute checkpoint tag for a
 * slice only if the worktree does not already exist. Safe to call multiple
 * times (e.g. from both execute.prepare and session_start marker delivery).
 * Returns the worktree path.
 */
export function ensureSliceWorktree(root: string, sLabel: string, milestoneBranch: string): string {
	const wtPath = createWorktree(root, sLabel, milestoneBranch);
	createCheckpoint(wtPath, sLabel, "pre-execute");
	return wtPath;
}

export function removeWorktree(root: string, sliceLabel: string): void {
	const wtPath = getWorktreePath(root, sliceLabel);
	const env = gitEnv();

	if (worktreeExists(root, sliceLabel)) {
		execFileSync("git", ["worktree", "remove", wtPath, "--force"], {
			cwd: root,
			encoding: "utf-8",
			env,
		});
	}

	const branchName = `slice/${sliceLabel}`;
	try {
		execFileSync("git", ["branch", "-D", branchName], {
			cwd: root,
			encoding: "utf-8",
			stdio: "pipe",
			env,
		});
	} catch {
		// Branch may not exist
	}
}
