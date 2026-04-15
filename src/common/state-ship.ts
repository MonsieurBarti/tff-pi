import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasOriginRemote, localBranchExists, remoteBranchExists, runGit } from "./git-internal.js";
import { projectHomeDir } from "./project-home.js";
import { commitStateAtPhaseEnd, pushWithRebaseRetry, stateBranchName } from "./state-branch.js";

export type FinalizeOutcome =
	| "finalized"
	| "finalized-local-only"
	| "skipped-no-state-branch"
	| "conflict-backup";

export interface FinalizeOpts {
	repoRoot: string;
	projectId: string;
	milestoneBranch: string; // e.g. "milestone/M10"
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
			console.warn(`finalize: failed to fetch ${stateBranch}: ${fetch.stderr}`);
			return "skipped-no-state-branch";
		}
	}

	// Step 4 — ensure parent state branch exists locally
	if (!localBranchExists(repoRoot, parentStateBranch)) {
		if (hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, parentStateBranch)) {
			const fetch = runGit(repoRoot, [
				"fetch",
				"origin",
				`${parentStateBranch}:refs/heads/${parentStateBranch}`,
			]);
			if (!fetch.ok) {
				console.warn(`finalize: fetch parent failed: ${fetch.stderr}`);
				return "conflict-backup";
			}
		} else {
			const orphanOk = await createOrphanParent(repoRoot, projectId, parentStateBranch);
			if (!orphanOk) return "conflict-backup";
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
			console.warn(`finalize: worktree add failed: ${add.stderr}`);
			return "conflict-backup";
		}
		wtRegistered = true;

		const merge = runGit(tmpDir, [
			"merge",
			"--no-ff",
			"-m",
			`ship: merge ${stateBranch}`,
			stateBranch,
		]);
		if (!merge.ok) {
			runGit(tmpDir, ["merge", "--abort"]);
			const backupRef = `${stateBranch}--ship-conflict-${new Date()
				.toISOString()
				.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 4)}`;
			runGit(repoRoot, ["push", "origin", `${stateBranch}:refs/heads/${backupRef}`]);
			console.warn(`finalize: merge conflict; backup at ${backupRef}`);
			return "conflict-backup";
		}

		const push = await pushWithRebaseRetry(tmpDir, parentStateBranch);
		if (push === "conflict-backup" || push === "push-failed") {
			return "conflict-backup";
		}

		// Step 6 — tag the milestone state branch tip
		const tipResult = runGit(repoRoot, ["rev-parse", stateBranch]);
		if (!tipResult.ok) {
			console.warn(`finalize: rev-parse of ${stateBranch} failed: ${tipResult.stderr}`);
			return "conflict-backup";
		}
		const sha = tipResult.stdout.trim();
		const tag = archiveTagName(milestoneBranch);
		const tagResult = runGit(repoRoot, ["tag", tag, sha]);
		if (!tagResult.ok) {
			console.warn(`finalize: tag create failed: ${tagResult.stderr}`);
			return "conflict-backup";
		}
		if (hasOriginRemote(repoRoot)) {
			const tagPush = runGit(repoRoot, ["push", "origin", tag]);
			if (!tagPush.ok) {
				console.warn(`finalize: tag push failed (non-fatal): ${tagPush.stderr}`);
			}
		}

		// Step 7 — delete refs
		runGit(repoRoot, ["branch", "-D", stateBranch]);
		let remoteOk = true;
		if (hasOriginRemote(repoRoot)) {
			const del = runGit(repoRoot, ["push", "origin", `:${stateBranch}`]);
			if (!del.ok) {
				console.warn(`finalize: remote delete failed: ${del.stderr}`);
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

// Placeholder stub; Task 4 replaces with real lazy-orphan creation.
async function createOrphanParent(
	_repoRoot: string,
	_projectId: string,
	_parentStateBranch: string,
): Promise<boolean> {
	return false;
}
