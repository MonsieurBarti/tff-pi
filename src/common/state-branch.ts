import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gitEnv } from "./git.js";

export class StateBranchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateBranchError";
	}
}

export function stateBranchName(codeBranch: string): string {
	return `tff-state/${codeBranch}`;
}

const EXCLUDED_TOP = new Set<string>([
	".tmp",
	"worktrees",
	"logs",
	".gitconfig",
	"repo-path",
	"repo-state.json",
	"session.lock",
	"pending-phase-message.txt",
]);

function isExcludedPath(relPath: string): boolean {
	// top-level excludes
	const first = relPath.split("/")[0] ?? "";
	if (EXCLUDED_TOP.has(first)) return true;
	// state.db and sidecars (state.db, state.db-journal, state.db-wal, state.db-shm)
	if (relPath === "state.db" || relPath.startsWith("state.db-")) return true;
	return false;
}

export function mirrorPortableSubset(homeDir: string, worktreeDir: string): void {
	const homeReal = realpathSync(homeDir);
	walk(homeReal, homeReal, worktreeDir);
}

function walk(homeReal: string, currentAbs: string, destRoot: string): void {
	const entries = readdirSync(currentAbs, { withFileTypes: true });
	for (const entry of entries) {
		const absPath = join(currentAbs, entry.name);
		const relPath = relative(homeReal, absPath);
		if (isExcludedPath(relPath)) continue;
		// Path-traversal guard: resolved real path must stay inside homeReal.
		let resolved: string;
		try {
			resolved = realpathSync(absPath);
		} catch {
			continue;
		}
		// Traversal guard: resolved real path must stay inside homeReal.
		if (!resolved.startsWith(homeReal + sep) && resolved !== homeReal) continue;

		const destAbs = join(destRoot, relPath);
		const stat = lstatSync(absPath);
		if (stat.isDirectory()) {
			mkdirSync(destAbs, { recursive: true });
			walk(homeReal, absPath, destRoot);
		} else if (stat.isSymbolicLink()) {
			// Resolve the symlink target's real type to avoid EISDIR when copying.
			let targetStat: ReturnType<typeof statSync>;
			try {
				targetStat = statSync(resolved);
			} catch {
				continue;
			}
			if (targetStat.isDirectory()) {
				// Symlink points to a directory — skip to avoid EISDIR.
				continue;
			}
			mkdirSync(dirname(destAbs), { recursive: true });
			copyFileSync(resolved, destAbs);
		} else if (stat.isFile()) {
			mkdirSync(dirname(destAbs), { recursive: true });
			copyFileSync(resolved, destAbs);
		}
	}
}

// ---------------------------------------------------------------------------
// Internal git helpers (non-exported, used by later tasks)
// ---------------------------------------------------------------------------

interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): ExecResult {
	try {
		const stdout = execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf-8",
			stdio: "pipe",
			env: gitEnv(),
		});
		return { ok: true, stdout: stdout.toString(), stderr: "" };
	} catch (err) {
		const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
		return {
			ok: false,
			stdout: e.stdout?.toString() ?? "",
			stderr: e.stderr?.toString() ?? "",
		};
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used by ensureStateBranch (Task 4+)
function localBranchExists(repoRoot: string, branch: string): boolean {
	return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

// biome-ignore lint/correctness/noUnusedVariables: used by pushWithRebaseRetry (Task 5+)
function remoteBranchExists(repoRoot: string, branch: string): boolean {
	const r = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch]);
	if (!r.ok) return false;
	return r.stdout.trim().length > 0;
}

// biome-ignore lint/correctness/noUnusedVariables: used by ensureStateBranch and pushWithRebaseRetry (Task 4+)
function hasOriginRemote(repoRoot: string): boolean {
	const r = runGit(repoRoot, ["remote"]);
	if (!r.ok) return false;
	return r.stdout
		.split("\n")
		.map((s) => s.trim())
		.includes("origin");
}

// biome-ignore lint/correctness/noUnusedVariables: used by ensureStateBranch (Task 4+)
function currentBranch(repoRoot: string): string | null {
	const r = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!r.ok) return null;
	const b = r.stdout.trim();
	return b === "HEAD" ? null : b;
}
