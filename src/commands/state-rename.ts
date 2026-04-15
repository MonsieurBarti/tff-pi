import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";
import {
	hasOriginRemote,
	localBranchExists,
	remoteBranchExists,
	runGit,
} from "../common/git-internal.js";
import { projectHomeDir, readProjectIdFile } from "../common/project-home.js";
import { readRepoState, writeRepoState } from "../common/repo-state.js";
import { isStateBranchEnabledForRoot } from "../common/state-branch-toggle.js";
import { pushWithRebaseRetry, stateBranchName } from "../common/state-branch.js";

const BRANCH_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._/\-]*$/;

export async function runStateRename(
	pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const root = ctx.projectRoot;
	if (!root) {
		pi.sendUserMessage("Error: no project root in context. Run /tff init first.");
		return;
	}

	const newCodeBranch = args[0];

	if (!newCodeBranch) {
		pi.sendUserMessage("Usage: /tff state rename <newCodeBranch>");
		return;
	}
	if (!BRANCH_NAME_RE.test(newCodeBranch)) {
		pi.sendUserMessage(`Error: invalid branch name: ${JSON.stringify(newCodeBranch)}`);
		return;
	}

	if (!isStateBranchEnabledForRoot(root)) {
		pi.sendUserMessage(
			"Error: state branches are disabled (settings.yaml: state_branch.enabled=false); nothing to rename.",
		);
		return;
	}

	const projectId = readProjectIdFile(root);
	if (!projectId) {
		pi.sendUserMessage("Error: project not initialized (missing .tff-project-id). Run /tff init.");
		return;
	}

	const repoState = readRepoState(projectId);
	if (!repoState) {
		pi.sendUserMessage(
			"Error: no prior state recorded (repo-state.json missing). Cannot determine source state branch.",
		);
		return;
	}

	const oldCodeBranch = repoState.lastKnownCodeBranch;
	const oldStateBranch = stateBranchName(oldCodeBranch);
	const newStateBranch = stateBranchName(newCodeBranch);

	if (oldStateBranch === newStateBranch) {
		pi.sendUserMessage(`${newStateBranch} is already the current state branch; nothing to do.`);
		return;
	}

	const destLocal = localBranchExists(root, newStateBranch);
	const withRemote = hasOriginRemote(root);
	const destRemote = withRemote && remoteBranchExists(root, newStateBranch);
	const srcLocal = localBranchExists(root, oldStateBranch);

	// Idempotent: destination already exists and source is gone — refresh repo-state and succeed.
	if ((destLocal || destRemote) && !srcLocal) {
		writeRepoState(projectId, { lastKnownCodeBranch: newCodeBranch });
		pi.sendUserMessage(`State branch already renamed to ${newStateBranch}; repo-state refreshed.`);
		return;
	}
	if (destLocal || destRemote) {
		pi.sendUserMessage(
			`Error: destination state branch ${newStateBranch} already exists; resolve manually.`,
		);
		return;
	}
	if (!srcLocal) {
		pi.sendUserMessage(
			`Error: source state branch ${oldStateBranch} not found locally; nothing to rename.`,
		);
		return;
	}

	const mv = runGit(root, ["branch", "-m", oldStateBranch, newStateBranch]);
	if (!mv.ok) {
		pi.sendUserMessage(`Error: git branch -m failed: ${mv.stderr}`);
		return;
	}

	if (withRemote) {
		const pub = runGit(root, ["push", "-u", "origin", newStateBranch]);
		if (!pub.ok) {
			pi.sendUserMessage(`Warning: could not publish ${newStateBranch} to origin: ${pub.stderr}`);
		}
		const del = runGit(root, ["push", "origin", `:${oldStateBranch}`]);
		if (!del.ok) {
			pi.sendUserMessage(
				`Warning: could not delete ${oldStateBranch} from origin (may be PR head): ${del.stderr}`,
			);
		}
	}

	// Patch branch-meta.json (best-effort via worktree).
	const home = projectHomeDir(projectId);
	const tmpDir = join(home, ".tmp", `state-rename-wt-${randomUUID()}`);
	mkdirSync(dirname(tmpDir), { recursive: true });
	let wtRegistered = false;
	try {
		const add = runGit(root, ["worktree", "add", tmpDir, newStateBranch]);
		if (!add.ok) {
			pi.sendUserMessage(`Warning: could not add worktree for branch-meta patch: ${add.stderr}`);
		} else {
			wtRegistered = true;
			const metaPath = join(tmpDir, "branch-meta.json");
			try {
				const raw = readFileSync(metaPath, "utf-8");
				const meta = JSON.parse(raw) as Record<string, unknown>;
				meta.codeBranch = newCodeBranch;
				writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
				runGit(tmpDir, ["add", "branch-meta.json"]);
				const commit = runGit(tmpDir, [
					"commit",
					"-m",
					`chore(state): rename ${oldCodeBranch} -> ${newCodeBranch}`,
				]);
				if (commit.ok) {
					await pushWithRebaseRetry(tmpDir, newStateBranch);
				}
			} catch (err) {
				pi.sendUserMessage(`Warning: branch-meta patch failed: ${err}`);
			}
		}
	} finally {
		if (wtRegistered) runGit(root, ["worktree", "remove", "--force", tmpDir]);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}

	writeRepoState(projectId, { lastKnownCodeBranch: newCodeBranch });
	pi.sendUserMessage(`Renamed state branch: ${oldStateBranch} -> ${newStateBranch}`);
}
