import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasOriginRemote, localBranchExists, remoteBranchExists, runGit } from "./git-internal.js";
import { logWarning } from "./logger.js";
import { projectHomeDir } from "./project-home.js";
import { isStateBranchEnabledForRoot } from "./state-branch-toggle.js";
import { commitStateAtPhaseEnd, pushWithRebaseRetry, stateBranchName } from "./state-branch.js";

export type FinalizeOutcome =
	| "finalized"
	| "finalized-local-only"
	| "skipped-no-state-branch"
	| "skipped-disabled"
	| "conflict-backup";

export interface FinalizeOpts {
	repoRoot: string;
	projectId: string;
	milestoneBranch: string; // e.g. "milestone/<8hex>" (UUID-form post-M11-S04)
	parentBranch: string; // e.g. "main"
}

function archiveTagName(milestoneBranch: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const uuid = randomUUID().slice(0, 4);
	return `tff-state/_archived/${milestoneBranch}-${ts}-${uuid}`;
}

export async function finalizeStateBranchForMilestone(
	opts: FinalizeOpts,
): Promise<FinalizeOutcome> {
	if (!isStateBranchEnabledForRoot(opts.repoRoot)) return "skipped-disabled";
	const { repoRoot, projectId, milestoneBranch, parentBranch } = opts;
	const stateBranch = stateBranchName(milestoneBranch);
	const parentStateBranch = stateBranchName(parentBranch);

	// Short-circuit: nothing to finalize
	const existsLocal = localBranchExists(repoRoot, stateBranch);
	const existsRemote = hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, stateBranch);
	if (!existsLocal && !existsRemote) return "skipped-no-state-branch";

	// Step 3 — final phase-end commit captures terminal state
	await commitStateAtPhaseEnd({
		repoRoot,
		projectId,
		codeBranch: milestoneBranch,
		phase: "ship",
		sliceLabel: milestoneBranch,
	});

	// Ensure the live local ref exists (fetch from origin if only remote)
	if (!localBranchExists(repoRoot, stateBranch)) {
		const fetch = runGit(repoRoot, ["fetch", "origin", `${stateBranch}:refs/heads/${stateBranch}`]);
		if (!fetch.ok) {
			logWarning("ship", "fetch-failed", { fn: "finalize", id: stateBranch, stderr: fetch.stderr });
			return "skipped-no-state-branch";
		}
	}

	// Step 4 — ensure parent state branch exists locally
	let parentWasLazyCreated = false;
	if (!localBranchExists(repoRoot, parentStateBranch)) {
		if (hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, parentStateBranch)) {
			const fetch = runGit(repoRoot, [
				"fetch",
				"origin",
				`${parentStateBranch}:refs/heads/${parentStateBranch}`,
			]);
			if (!fetch.ok) {
				logWarning("ship", "fetch-parent-failed", { fn: "finalize", stderr: fetch.stderr });
				return "conflict-backup";
			}
		} else {
			const orphanOk = await createOrphanParent(repoRoot, projectId, parentStateBranch);
			if (!orphanOk) return "conflict-backup";
			parentWasLazyCreated = true;
		}
	}

	// Step 5 — merge in disposable worktree
	const home = projectHomeDir(projectId);
	const tmpDir = join(home, ".tmp", `state-wt-${randomUUID()}`);
	mkdirSync(dirname(tmpDir), { recursive: true });

	let wtRegistered = false;
	try {
		const add = runGit(repoRoot, ["worktree", "add", tmpDir, parentStateBranch]);
		if (!add.ok) {
			logWarning("ship", "worktree-add-failed", { fn: "finalize", stderr: add.stderr });
			return "conflict-backup";
		}
		wtRegistered = true;

		const mergeArgs = ["merge", "--no-ff", "-m", `ship: merge ${stateBranch}`, stateBranch];
		if (parentWasLazyCreated) {
			// Lazy-created orphan parent has no shared history and only scaffold
			// files (.gitattributes, branch-meta.json). Take the milestone side
			// unconditionally for those — the parent is empty by construction.
			mergeArgs.splice(1, 0, "--allow-unrelated-histories", "-X", "theirs");
		}
		const merge = runGit(tmpDir, mergeArgs);
		if (!merge.ok) {
			runGit(tmpDir, ["merge", "--abort"]);
			const backupRef = `${stateBranch}--ship-conflict-${new Date()
				.toISOString()
				.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 4)}`;
			runGit(repoRoot, ["push", "origin", `${stateBranch}:refs/heads/${backupRef}`]);
			logWarning("ship", "merge-conflict-backup", { fn: "finalize", id: backupRef });
			return "conflict-backup";
		}

		const push = await pushWithRebaseRetry(tmpDir, parentStateBranch);
		if (push === "conflict-backup" || push === "push-failed") {
			return "conflict-backup";
		}

		// Step 6 — tag the milestone state branch tip
		const tipResult = runGit(repoRoot, ["rev-parse", stateBranch]);
		if (!tipResult.ok) {
			logWarning("ship", "rev-parse-failed", {
				fn: "finalize",
				id: stateBranch,
				stderr: tipResult.stderr,
			});
			return "conflict-backup";
		}
		const sha = tipResult.stdout.trim();
		const tag = archiveTagName(milestoneBranch);
		const tagResult = runGit(repoRoot, ["tag", tag, sha]);
		if (!tagResult.ok) {
			logWarning("ship", "tag-create-failed", { fn: "finalize", stderr: tagResult.stderr });
			return "conflict-backup";
		}
		if (hasOriginRemote(repoRoot)) {
			const tagPush = runGit(repoRoot, ["push", "origin", tag]);
			if (!tagPush.ok) {
				logWarning("ship", "tag-push-failed", { fn: "finalize", stderr: tagPush.stderr });
			}
		}

		// Step 7 — delete refs
		runGit(repoRoot, ["branch", "-D", stateBranch]);
		let remoteOk = true;
		if (hasOriginRemote(repoRoot)) {
			const del = runGit(repoRoot, ["push", "origin", `:${stateBranch}`]);
			if (!del.ok) {
				logWarning("ship", "remote-delete-failed", { fn: "finalize", stderr: del.stderr });
				remoteOk = false;
			}
		} else {
			remoteOk = false;
		}

		return remoteOk ? "finalized" : "finalized-local-only";
	} finally {
		if (wtRegistered) {
			runGit(repoRoot, ["worktree", "remove", "--force", tmpDir]);
		}
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

const ORPHAN_GITATTRIBUTES = "state-snapshot.json merge=tff-snapshot\n";

async function createOrphanParent(
	repoRoot: string,
	projectId: string,
	parentStateBranch: string,
): Promise<boolean> {
	const home = projectHomeDir(projectId);
	const tmpDir = join(home, ".tmp", `state-wt-${randomUUID()}`);
	mkdirSync(dirname(tmpDir), { recursive: true });

	let wtRegistered = false;
	try {
		const add = runGit(repoRoot, ["worktree", "add", "--detach", tmpDir, "HEAD"]);
		if (!add.ok) {
			logWarning("ship", "worktree-add-failed", { fn: "createOrphanParent", stderr: add.stderr });
			return false;
		}
		wtRegistered = true;

		const orphan = runGit(tmpDir, ["checkout", "--orphan", parentStateBranch]);
		if (!orphan.ok) return false;
		runGit(tmpDir, ["rm", "-rf", "--ignore-unmatch", "."]);

		writeFileSync(join(tmpDir, ".gitattributes"), ORPHAN_GITATTRIBUTES, "utf-8");
		const meta = {
			stateId: randomUUID(),
			parent: null as string | null,
			codeBranch: parentStateBranch.replace(/^tff-state\//, ""),
			createdAt: new Date().toISOString(),
		};
		writeFileSync(join(tmpDir, "branch-meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
		const add2 = runGit(tmpDir, ["add", "-A"]);
		if (!add2.ok) return false;
		const commit = runGit(tmpDir, [
			"commit",
			"-m",
			`chore(state): lazy-create ${parentStateBranch}`,
		]);
		if (!commit.ok) return false;

		return true;
	} finally {
		if (wtRegistered) runGit(repoRoot, ["worktree", "remove", "--force", tmpDir]);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}
