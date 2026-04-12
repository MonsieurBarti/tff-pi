import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function gitEnv(): Record<string, string | undefined> {
	return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
}

export function getGitRoot(cwd?: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
	} catch {
		return null;
	}
}

export function getCurrentBranch(cwd?: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
	} catch {
		return null;
	}
}

export function getDiff(baseBranch: string, cwd?: string): string | null {
	try {
		return execFileSync("git", ["diff", `${baseBranch}...HEAD`], {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: "pipe",
			env: gitEnv(),
		}).trim();
	} catch {
		return null;
	}
}

export function branchExists(branchName: string, cwd?: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--verify", branchName], {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

export function createBranch(branchName: string, startPoint: string, cwd?: string): void {
	execFileSync("git", ["branch", branchName, startPoint], {
		cwd: cwd ?? process.cwd(),
		encoding: "utf-8",
	});
}

export function initRepo(cwd?: string): void {
	execFileSync("git", ["init"], {
		cwd: cwd ?? process.cwd(),
		encoding: "utf-8",
		stdio: "pipe",
	});
}

export function getDefaultBranch(cwd?: string): string | null {
	try {
		const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		// ref is like "refs/remotes/origin/main" — extract last segment
		return ref.split("/").pop() ?? null;
	} catch {
		return null;
	}
}

const DEFAULT_GITIGNORE_ENTRIES = [
	".tff/",
	".pi/",
	"node_modules/",
	"dist/",
	".DS_Store",
	"*.log",
	".env",
	".env.*",
	"coverage/",
];

export function createGitignore(cwd: string): void {
	const filePath = join(cwd, ".gitignore");
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
	const existingLines = new Set(
		existing
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	);
	const missing = DEFAULT_GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
	if (missing.length > 0) {
		const suffix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		const header = existing.length > 0 ? "\n# TFF defaults\n" : "";
		writeFileSync(filePath, `${existing}${suffix}${header}${missing.join("\n")}\n`);
	}
	// Defensively untrack .tff/ and .pi/ if a reused remote has them committed.
	// Observed: testtff project inherited a prior project's .tff/state.db via
	// rebase, so getNextMilestoneNumber saw an M01 row and handed out M02.
	// --ignore-unmatch keeps this a no-op when nothing is tracked.
	execFileSync("git", ["rm", "-r", "--cached", "--ignore-unmatch", ".tff", ".pi"], {
		cwd,
		stdio: "pipe",
	});
}

export function hasRemote(cwd?: string): boolean {
	try {
		const output = execFileSync("git", ["remote"], {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		return output.length > 0;
	} catch {
		return false;
	}
}

export function addRemote(url: string, cwd?: string): void {
	execFileSync("git", ["remote", "add", "origin", url], {
		cwd: cwd ?? process.cwd(),
		encoding: "utf-8",
		stdio: "pipe",
	});
}

export function initialCommitAndPush(cwd?: string): void {
	const dir = cwd ?? process.cwd();
	execFileSync("git", ["add", ".gitignore"], {
		cwd: dir,
		encoding: "utf-8",
		stdio: "pipe",
	});
	execFileSync("git", ["commit", "-m", "chore: initial commit"], {
		cwd: dir,
		encoding: "utf-8",
		stdio: "pipe",
	});
	execFileSync("git", ["push", "-u", "origin", "HEAD"], {
		cwd: dir,
		encoding: "utf-8",
		stdio: "pipe",
	});
}

/**
 * Push a branch to origin and set upstream. No-op if no remote is configured.
 *
 * Called when the milestone branch is created so the slice PR has a valid
 * base ref on GitHub. Without this, `gh pr create` fails with
 * "Base ref must be a branch" because the milestone branch exists only
 * locally when the slice is shipped.
 */
export function pushBranch(branchName: string, cwd: string): void {
	if (!hasRemote(cwd)) return;
	execFileSync("git", ["push", "-u", "origin", branchName], {
		cwd,
		encoding: "utf-8",
		stdio: "pipe",
	});
}

/**
 * Returns true if the remote has a ref named `<branchName>`. Requires a remote
 * named `origin`. Used by cleanup paths to decide whether to push/delete a
 * branch on the remote rather than relying on try/catch around `git push`.
 */
export function remoteBranchExists(branchName: string, cwd: string): boolean {
	if (!hasRemote(cwd)) return false;
	const output = execFileSync("git", ["ls-remote", "--heads", "origin", branchName], {
		cwd,
		encoding: "utf-8",
		stdio: "pipe",
	}).trim();
	return output.length > 0;
}
