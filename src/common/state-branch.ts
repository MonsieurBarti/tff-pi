import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { openDatabase } from "./db.js";
import { gitEnv } from "./git.js";
import { projectHomeDir } from "./project-home.js";
import { writeSnapshot } from "./state-exporter.js";
import type { Phase } from "./types.js";

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

function localBranchExists(repoRoot: string, branch: string): boolean {
	return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function remoteBranchExists(repoRoot: string, branch: string): boolean {
	const r = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch]);
	if (!r.ok) return false;
	return r.stdout.trim().length > 0;
}

function hasOriginRemote(repoRoot: string): boolean {
	const r = runGit(repoRoot, ["remote"]);
	if (!r.ok) return false;
	return r.stdout
		.split("\n")
		.map((s) => s.trim())
		.includes("origin");
}

function currentBranch(repoRoot: string): string | null {
	const r = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!r.ok) return null;
	const b = r.stdout.trim();
	return b === "HEAD" ? null : b;
}

// ---------------------------------------------------------------------------
// ensureStateBranch and helpers
// ---------------------------------------------------------------------------

const ORPHAN_GITATTRIBUTES = "state-snapshot.json merge=tff-snapshot\n";

function isSliceWorktree(projectId: string): boolean {
	return existsSync(join(projectHomeDir(projectId), "slice-worktree.marker"));
}

// HEURISTIC: Pick the local branch whose merge-base with `codeBranch` has the
// most recent commit timestamp. This approximates `git merge-base --fork-point`
// without requiring the reflog. Known edge case: a stale sibling branch whose
// tip sits on a recent main commit can win the timestamp race over `main`; the
// fallout is benign (fork `tff-state/<sibling>` instead of `tff-state/main`,
// both are valid portable-state parents).
function findParentCodeBranch(repoRoot: string, codeBranch: string): string | null {
	const list = runGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
	if (!list.ok) return null;
	const branches = list.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	let bestBranch: string | null = null;
	let bestTs = Number.NEGATIVE_INFINITY;
	for (const cand of branches) {
		if (cand === codeBranch) continue;
		if (cand.startsWith("tff-state/")) continue;
		const base = runGit(repoRoot, ["merge-base", cand, codeBranch]);
		if (!base.ok) continue;
		const mergeBase = base.stdout.trim();
		if (!mergeBase) continue;
		const ts = runGit(repoRoot, ["log", "-1", "--format=%ct", mergeBase]);
		if (!ts.ok) continue;
		const n = Number(ts.stdout.trim());
		if (!Number.isFinite(n)) continue;
		if (n > bestTs) {
			bestTs = n;
			bestBranch = cand;
		}
	}
	return bestBranch;
}

async function createOrphanStateBranch(
	repoRoot: string,
	projectId: string,
	stateBranch: string,
	codeBranch: string,
): Promise<void> {
	const tmpDir = join(projectHomeDir(projectId), ".tmp", `state-wt-${randomUUID()}`);
	mkdirSync(dirname(tmpDir), { recursive: true });

	let wtRegistered = false;
	try {
		const add = runGit(repoRoot, ["worktree", "add", "--detach", tmpDir, "HEAD"]);
		if (!add.ok) throw new StateBranchError(`worktree add failed: ${add.stderr}`);
		wtRegistered = true;

		const orphan = runGit(tmpDir, ["checkout", "--orphan", stateBranch]);
		if (!orphan.ok) throw new StateBranchError(`checkout --orphan failed: ${orphan.stderr}`);
		// Remove everything that came with HEAD so we land on an empty tree.
		runGit(tmpDir, ["rm", "-rf", "--ignore-unmatch", "."]);

		writeFileSync(join(tmpDir, ".gitattributes"), ORPHAN_GITATTRIBUTES, "utf-8");
		const meta = {
			stateId: randomUUID(),
			parent: null as string | null,
			codeBranch,
			createdAt: new Date().toISOString(),
		};
		writeFileSync(join(tmpDir, "branch-meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

		const add2 = runGit(tmpDir, ["add", "-A"]);
		if (!add2.ok) throw new StateBranchError(`git add failed: ${add2.stderr}`);
		const commit = runGit(tmpDir, ["commit", "-m", `chore(state): initialize ${stateBranch}`]);
		if (!commit.ok) throw new StateBranchError(`git commit failed: ${commit.stderr}`);
	} finally {
		if (wtRegistered) runGit(repoRoot, ["worktree", "remove", "--force", tmpDir]);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

// ---------------------------------------------------------------------------
// commitStateAtPhaseEnd
// ---------------------------------------------------------------------------

export interface CommitStateOpts {
	repoRoot: string;
	projectId: string;
	codeBranch: string;
	phase: Phase;
	sliceLabel: string;
	freezeLogForSlice?: string;
}

const COMMIT_TIMEOUT_MS = 10_000;

export async function commitStateAtPhaseEnd(opts: CommitStateOpts): Promise<void> {
	const deadline = new Promise<void>((resolve) => {
		setTimeout(() => {
			console.warn("commitStateAtPhaseEnd: timed out after 10s");
			resolve();
		}, COMMIT_TIMEOUT_MS).unref();
	});
	await Promise.race([runCommit(opts), deadline]);
}

async function runCommit(opts: CommitStateOpts): Promise<void> {
	const { repoRoot, projectId, codeBranch, phase, sliceLabel, freezeLogForSlice } = opts;
	if (!codeBranch) return;
	const stateBranch = stateBranchName(codeBranch);
	const home = projectHomeDir(projectId);
	const tmpDir = join(home, ".tmp", `state-wt-${randomUUID()}`);
	mkdirSync(dirname(tmpDir), { recursive: true });

	let wtRegistered = false;
	try {
		const add = runGit(repoRoot, ["worktree", "add", tmpDir, stateBranch]);
		if (!add.ok) {
			console.warn(`commitStateAtPhaseEnd: worktree add failed: ${add.stderr}`);
			return;
		}
		wtRegistered = true;

		const dbPath = join(home, "state.db");
		const snapshotPath = join(tmpDir, "state-snapshot.json");
		// Read the existing snapshot (if any) before overwriting — used for no-op detection.
		let existingSnapshotRaw: string | null = null;
		if (existsSync(snapshotPath)) {
			try {
				existingSnapshotRaw = readFileSync(snapshotPath, "utf-8");
			} catch {
				// best-effort
			}
		}
		const db = openDatabase(dbPath);
		try {
			writeSnapshot(db, tmpDir);
		} finally {
			db.close();
		}
		// If the only change is exportedAt (a timestamp), restore the prior snapshot so
		// git sees no diff and we avoid an empty commit.
		if (existingSnapshotRaw !== null) {
			try {
				const newRaw = readFileSync(snapshotPath, "utf-8");
				const stripTs = (s: string): string =>
					s.replace(/"exportedAt"\s*:\s*"[^"]*"/, '"exportedAt":""');
				if (stripTs(existingSnapshotRaw) === stripTs(newRaw)) {
					writeFileSync(snapshotPath, existingSnapshotRaw, "utf-8");
				}
			} catch {
				// best-effort — worst case we get an extra commit
			}
		}

		mirrorPortableSubset(home, tmpDir);

		if (freezeLogForSlice) {
			const src = join(home, "logs", `${freezeLogForSlice}.jsonl`);
			const dst = join(tmpDir, "logs", `${freezeLogForSlice}.jsonl`);
			if (existsSync(src)) {
				mkdirSync(dirname(dst), { recursive: true });
				copyFileSync(src, dst);
			} else {
				console.warn(`commitStateAtPhaseEnd: missing log ${src}, skipping freeze`);
			}
		}

		const add2 = runGit(tmpDir, ["add", "-A"]);
		if (!add2.ok) {
			console.warn(`commitStateAtPhaseEnd: git add failed: ${add2.stderr}`);
			return;
		}

		const status = runGit(tmpDir, ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim().length === 0) {
			return; // no changes — avoid empty commit
		}

		const suffix = freezeLogForSlice ? " (slice complete)" : "";
		const commit = runGit(tmpDir, ["commit", "-m", `${phase}: ${sliceLabel}${suffix}`]);
		if (!commit.ok) {
			console.warn(`commitStateAtPhaseEnd: commit failed: ${commit.stderr}`);
			return;
		}

		// Push is added in Tasks 9-11.
	} catch (err) {
		console.warn("commitStateAtPhaseEnd: unexpected error", err);
	} finally {
		if (wtRegistered) runGit(repoRoot, ["worktree", "remove", "--force", tmpDir]);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

export async function ensureStateBranch(repoRoot: string, projectId: string): Promise<void> {
	if (isSliceWorktree(projectId)) return;

	const codeBranch = currentBranch(repoRoot);
	if (!codeBranch) {
		console.warn("ensureStateBranch: detached HEAD, skipping");
		return;
	}
	const stateBranch = stateBranchName(codeBranch);

	if (localBranchExists(repoRoot, stateBranch)) return;

	// Try remote tracking ref for this exact stateBranch first.
	if (hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, stateBranch)) {
		const fetch = runGit(repoRoot, ["fetch", "origin", `${stateBranch}:refs/heads/${stateBranch}`]);
		if (fetch.ok) return;
		console.warn(`ensureStateBranch: fetch of ${stateBranch} failed: ${fetch.stderr}`);
	}

	// Try to fork from the state branch of the merge-base-derived parent code branch.
	const parentCode = findParentCodeBranch(repoRoot, codeBranch);
	if (parentCode) {
		const parentState = stateBranchName(parentCode);
		if (localBranchExists(repoRoot, parentState)) {
			const br = runGit(repoRoot, ["branch", stateBranch, parentState]);
			if (br.ok) return;
			console.warn(`ensureStateBranch: branch from ${parentState} failed: ${br.stderr}`);
		}
		if (hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, parentState)) {
			const fetch = runGit(repoRoot, [
				"fetch",
				"origin",
				`${parentState}:refs/heads/${parentState}`,
			]);
			if (fetch.ok) {
				const br = runGit(repoRoot, ["branch", stateBranch, parentState]);
				if (br.ok) return;
			}
		}
	}

	await createOrphanStateBranch(repoRoot, projectId, stateBranch, codeBranch);
}
