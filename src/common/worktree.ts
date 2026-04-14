import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createCheckpoint } from "./checkpoint.js";
import { gitEnv } from "./git.js";
import { ProjectHomeError, createTffSymlink, readProjectIdFile } from "./project-home.js";

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
		// Resolve symlinks before comparing: on macOS /var is a symlink to /private/var,
		// and git outputs the real path, so a naive includes() would miss symlinked paths.
		const realWtPath = realpathSync(wtPath);
		return output.includes(wtPath) || output.includes(realWtPath);
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

	// M10-S01: recreate the .tff/ symlink inside the new worktree so it shares
	// the main project home. The git checkout includes .tff-project-id (tracked)
	// but not the .tff/ symlink (gitignored). After symlink creation, slice
	// worktrees read/write the same DB and artifacts as the main repo.
	const projectId = readProjectIdFile(root);
	if (!projectId) {
		throw new ProjectHomeError(
			"Cannot create slice worktree before /tff init — .tff-project-id is missing.",
		);
	}
	createTffSymlink(wtPath, projectId);

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
