import { execFileSync } from "node:child_process";

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
