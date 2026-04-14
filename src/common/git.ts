import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Strip every GIT_* variable that can redirect git's view of the repository.
// Pre-commit hooks run with GIT_DIR, GIT_INDEX_FILE, GIT_PREFIX, GIT_AUTHOR_*
// and GIT_EXEC_PATH set by the parent git process; a child `git add` with
// cwd=tempRepo that inherits these will happily write the blob to the temp
// repo's objects but the index entry to the *outer* worktree's index, which
// manifests as "ghost staging" (index hash not in objects). Scrubbing only
// GIT_DIR/GIT_WORK_TREE is insufficient — GIT_INDEX_FILE alone reproduces it.
//
// Keep in sync with:
//   - scripts/scrub-git-env.sh (shell-layer scrub for lefthook)
//   - tests/unit/common/git-env-scrub.spec.ts (regression guard with canary)
const GIT_REDIRECT_ENV_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
] as const;

export function gitEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of GIT_REDIRECT_ENV_VARS) delete env[key];
	return env;
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
	"/.tff",
	".pi/",
	"node_modules/",
	"dist/",
	".DS_Store",
	"*.log",
	".env",
	".env.*",
	"coverage/",
];

export function ensureGitignoreEntries(cwd: string): void {
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
		env: gitEnv(),
	});
}

// Keep legacy name as a thin alias so existing callers compile until T11 removes it.
export const createGitignore = ensureGitignoreEntries;

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
	const env = gitEnv();
	execFileSync("git", ["add", ".gitignore"], {
		cwd: dir,
		encoding: "utf-8",
		stdio: "pipe",
		env,
	});
	execFileSync("git", ["commit", "-m", "chore: initial commit"], {
		cwd: dir,
		encoding: "utf-8",
		stdio: "pipe",
		env,
	});
	execFileSync("git", ["push", "-u", "origin", "HEAD"], {
		cwd: dir,
		encoding: "utf-8",
		stdio: "pipe",
		env,
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
