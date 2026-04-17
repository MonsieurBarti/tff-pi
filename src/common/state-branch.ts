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
import { isValidBranchName } from "./branch-names.js";
import { openDatabase } from "./db.js";
import { hasOriginRemote, localBranchExists, remoteBranchExists, runGit } from "./git-internal.js";
import { logException, logWarning } from "./logger.js";
import { projectHomeDir } from "./project-home.js";
import { writeRepoState } from "./repo-state.js";
import { isStateBranchEnabledForRoot } from "./state-branch-toggle.js";
import { writeSnapshot } from "./state-exporter.js";
import type { Phase } from "./types.js";

export class StateBranchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateBranchError";
	}
}

// Defense-in-depth: reject branch names that contain shell/arg-parsing traps
// before passing them to `git branch`/`git checkout`. git itself already
// rejects invalid refs via check-ref-format, but we want a hard gate at our
// own boundary so an attacker-controlled `codeBranch` can never reach git as
// something that could be interpreted as a flag or traversal.
// Path-traversal rejection (`.`, `..`, empty segments) is enforced by
// isValidBranchName in branch-names.ts.
function assertValidBranchName(name: string, label: string): void {
	if (!isValidBranchName(name)) {
		throw new StateBranchError(`invalid ${label} branch name: ${JSON.stringify(name)}`);
	}
}

export function stateBranchName(codeBranch: string): string {
	return `tff-state/${codeBranch}`;
}

// Allow-list of portable paths that may be mirrored from ~/.tff/<id>/ into the
// state worktree. Anything not matching is skipped — this prevents future files
// (leaked .env, OAuth tokens, debug dumps) from auto-mirroring to a pushed branch.
// Top-level files are exact matches; directories are recursive allow-prefixes.
const ALLOWED_TOP_FILES = new Set<string>([
	"settings.yaml",
	"branch-meta.json",
	"state-snapshot.json",
	".gitattributes",
]);
const ALLOWED_TOP_DIRS = new Set<string>(["milestones"]);

function isAllowedPath(relPath: string): boolean {
	const first = relPath.split("/")[0] ?? "";
	if (!first) return false;
	if (relPath === first) {
		// top-level entry: file allow-list, or a directory allow-prefix
		return ALLOWED_TOP_FILES.has(first) || ALLOWED_TOP_DIRS.has(first);
	}
	// nested entry: only allowed if under an allowed top-level directory
	return ALLOWED_TOP_DIRS.has(first);
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
		if (!isAllowedPath(relPath)) continue;
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
	if (!isStateBranchEnabledForRoot(opts.repoRoot)) return;
	const deadline = new Promise<void>((resolve) => {
		setTimeout(() => {
			logWarning("state-branch", "commit-state-timeout", { fn: "commitStateAtPhaseEnd" });
			resolve();
		}, COMMIT_TIMEOUT_MS).unref();
	});
	await Promise.race([runCommit(opts), deadline]);
}

async function runCommit(opts: CommitStateOpts): Promise<void> {
	const { repoRoot, projectId, codeBranch, phase, sliceLabel, freezeLogForSlice } = opts;
	if (!codeBranch) return;
	assertValidBranchName(codeBranch, "code");
	const stateBranch = stateBranchName(codeBranch);
	const home = projectHomeDir(projectId);
	const tmpDir = join(home, ".tmp", `state-wt-${randomUUID()}`);
	mkdirSync(dirname(tmpDir), { recursive: true });

	let wtRegistered = false;
	try {
		const add = runGit(repoRoot, ["worktree", "add", tmpDir, stateBranch]);
		if (!add.ok) {
			logWarning("state-branch", "commit-state-failed", {
				fn: "commitStateAtPhaseEnd",
				step: "worktree-add",
				stderr: add.stderr,
			});
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
		// NOTE: covered by "preserves committed snapshot bytes when only exportedAt differs" test.
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
				logWarning("state-branch", "missing-log-skipped", {
					fn: "commitStateAtPhaseEnd",
					id: src,
				});
			}
		}

		const add2 = runGit(tmpDir, ["add", "-A"]);
		if (!add2.ok) {
			logWarning("state-branch", "commit-state-failed", {
				fn: "commitStateAtPhaseEnd",
				step: "git-add",
				stderr: add2.stderr,
			});
			return;
		}

		const status = runGit(tmpDir, ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim().length === 0) {
			return; // no changes — avoid empty commit
		}

		const suffix = freezeLogForSlice ? " (slice complete)" : "";
		const commit = runGit(tmpDir, ["commit", "-m", `${phase}: ${sliceLabel}${suffix}`]);
		if (!commit.ok) {
			logWarning("state-branch", "commit-state-failed", {
				fn: "commitStateAtPhaseEnd",
				step: "commit",
				stderr: commit.stderr,
			});
			return;
		}

		// Push is best-effort: any outcome is acceptable.
		try {
			const pushOutcome = await pushWithRebaseRetry(tmpDir, stateBranch);
			if (pushOutcome === "pushed") {
				logWarning("state-branch", "pushed", { fn: "commitStateAtPhaseEnd", id: stateBranch });
			} else if (pushOutcome === "conflict-backup") {
				logWarning("state-branch", "push-conflict-backup", {
					fn: "commitStateAtPhaseEnd",
					id: stateBranch,
				});
			} else if (pushOutcome === "push-failed") {
				logWarning("state-branch", "push-failed-local-preserved", {
					fn: "commitStateAtPhaseEnd",
					id: stateBranch,
				});
			}
			// "skipped-no-remote" is silent
		} catch (pushErr) {
			logException("state-branch", pushErr, { fn: "commitStateAtPhaseEnd", id: stateBranch });
		}
	} catch (err) {
		logException("state-branch", err, { fn: "commitStateAtPhaseEnd" });
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
	if (!isStateBranchEnabledForRoot(repoRoot)) return;
	if (isSliceWorktree(projectId)) return;

	const codeBranch = currentBranch(repoRoot);
	if (!codeBranch) {
		logWarning("state-branch", "detached-head-skipped", { fn: "ensureStateBranch" });
		return;
	}
	assertValidBranchName(codeBranch, "code");
	const stateBranch = stateBranchName(codeBranch);

	const recordBranch = (): void => {
		try {
			writeRepoState(projectId, { lastKnownCodeBranch: codeBranch });
		} catch (err) {
			logException("state-branch", err, { fn: "ensureStateBranch", step: "write-repo-state" });
		}
	};

	if (localBranchExists(repoRoot, stateBranch)) {
		recordBranch();
		return;
	}

	// Try remote tracking ref for this exact stateBranch first.
	if (hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, stateBranch)) {
		const fetch = runGit(repoRoot, ["fetch", "origin", `${stateBranch}:refs/heads/${stateBranch}`]);
		if (fetch.ok) {
			recordBranch();
			return;
		}
		logWarning("state-branch", "fetch-failed", {
			fn: "ensureStateBranch",
			id: stateBranch,
			stderr: fetch.stderr,
		});
	}

	// Try to fork from the state branch of the merge-base-derived parent code branch.
	const parentCode = findParentCodeBranch(repoRoot, codeBranch);
	if (parentCode) {
		const parentState = stateBranchName(parentCode);
		if (localBranchExists(repoRoot, parentState)) {
			const br = runGit(repoRoot, ["branch", stateBranch, parentState]);
			if (br.ok) {
				recordBranch();
				return;
			}
			logWarning("state-branch", "branch-from-parent-failed", {
				fn: "ensureStateBranch",
				id: parentState,
				stderr: br.stderr,
			});
		}
		if (hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, parentState)) {
			const fetch = runGit(repoRoot, [
				"fetch",
				"origin",
				`${parentState}:refs/heads/${parentState}`,
			]);
			if (fetch.ok) {
				const br = runGit(repoRoot, ["branch", stateBranch, parentState]);
				if (br.ok) {
					recordBranch();
					return;
				}
			}
		}
	}

	await createOrphanStateBranch(repoRoot, projectId, stateBranch, codeBranch);
	recordBranch();
}

// ---------------------------------------------------------------------------
// pushWithRebaseRetry
// ---------------------------------------------------------------------------

export type PushOutcome = "pushed" | "conflict-backup" | "skipped-no-remote" | "push-failed";

export async function pushWithRebaseRetry(
	worktreeDir: string,
	stateBranch: string,
): Promise<PushOutcome> {
	if (!hasOriginRemote(worktreeDir)) return "skipped-no-remote";

	let backupKind: "conflict" | "churn" | null = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		const push = runGit(worktreeDir, ["push", "origin", stateBranch]);
		if (push.ok) return "pushed";
		const isNonFf =
			/non-fast-forward|\(fetch first\)|\(non-fast-forward\)/i.test(push.stderr) ||
			/rejected.*\(fetch first\)/i.test(push.stderr);
		if (!isNonFf) {
			// Non-retryable (auth/permission/disk-full/etc). Surface distinctly so
			// /tff doctor can spot it instead of conflating with the no-remote case.
			logWarning("state-branch", "push-non-retryable", {
				fn: "pushWithRebaseRetry",
				stderr: push.stderr,
			});
			return "push-failed";
		}
		const fetch = runGit(worktreeDir, [
			"fetch",
			"origin",
			`+${stateBranch}:refs/remotes/origin/${stateBranch}`,
		]);
		if (!fetch.ok) {
			logWarning("state-branch", "push-fetch-failed", {
				fn: "pushWithRebaseRetry",
				stderr: fetch.stderr,
			});
			return "push-failed";
		}
		const rebase = runGit(worktreeDir, ["rebase", `origin/${stateBranch}`]);
		if (!rebase.ok) {
			runGit(worktreeDir, ["rebase", "--abort"]);
			backupKind = "conflict";
			break;
		}
		// loop and retry push
	}

	if (backupKind === null) {
		// 3 attempts exhausted without a true conflict — remote is a moving target.
		logWarning("state-branch", "retry-cap-reached", {
			fn: "pushWithRebaseRetry",
			id: stateBranch,
		});
		backupKind = "churn";
	}

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	// Use "--<kind>-" (double dash) instead of "/<kind>-" to avoid a git ref
	// namespace collision: refs/heads/tff-state/main and refs/heads/tff-state/main/*
	// cannot coexist in the same repo.
	const backupRef = `${stateBranch}--${backupKind}-${ts}`;
	const saveRemoteTip = runGit(worktreeDir, [
		"push",
		"origin",
		`refs/remotes/origin/${stateBranch}:refs/heads/${backupRef}`,
	]);
	if (!saveRemoteTip.ok) {
		logWarning("state-branch", "save-remote-tip-failed", {
			fn: "pushWithRebaseRetry",
			stderr: saveRemoteTip.stderr,
		});
		// Still attempt force-push below so local progress is preserved.
	}
	// Default lease compares against refs/remotes/origin/<branch>, which we just
	// refreshed via the fetch above.
	const force = runGit(worktreeDir, ["push", "--force-with-lease", "origin", stateBranch]);
	if (!force.ok) {
		logWarning("state-branch", "force-push-backup-preserved", {
			fn: "pushWithRebaseRetry",
			id: backupRef,
			stderr: force.stderr,
		});
		return "conflict-backup";
	}
	if (backupKind === "conflict") {
		logWarning("state-branch", "state-conflict-preserved", {
			fn: "pushWithRebaseRetry",
			id: backupRef,
		});
	} else {
		logWarning("state-branch", "remote-churn-backup-preserved", {
			fn: "pushWithRebaseRetry",
			id: backupRef,
		});
	}
	return "conflict-backup";
}
