import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";
import {
	hasOriginRemote,
	localBranchExists,
	remoteBranchExists,
	runGit,
} from "../common/git-internal.js";
import { readProjectIdFile } from "../common/project-home.js";
import { writeRepoState } from "../common/repo-state.js";
import { isStateBranchEnabledForRoot } from "../common/state-branch-toggle.js";
import { stateBranchName } from "../common/state-branch.js";
import { runStateRename } from "./state-rename.js";

const BRANCH_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._/\-]*$/;

function currentBranch(repoRoot: string): string | null {
	const r = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!r.ok) return null;
	const b = r.stdout.trim();
	return b === "HEAD" ? null : b;
}

export async function runBranchRename(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const root = ctx.projectRoot;
	if (!root) {
		pi.sendUserMessage("Error: no project root in context. Run /tff init first.");
		return;
	}

	const newCodeBranch = args[0];

	if (!newCodeBranch) {
		pi.sendUserMessage("Usage: /tff branch rename <newCodeBranch>");
		return;
	}
	if (!BRANCH_NAME_RE.test(newCodeBranch)) {
		pi.sendUserMessage(`Error: invalid branch name: ${JSON.stringify(newCodeBranch)}`);
		return;
	}

	const oldCodeBranch = currentBranch(root);
	if (!oldCodeBranch) {
		pi.sendUserMessage("Error: detached HEAD; cannot rename.");
		return;
	}

	// Step 1: always rename the code branch (regardless of toggle)
	const mv = runGit(root, ["branch", "-m", newCodeBranch]);
	if (!mv.ok) {
		pi.sendUserMessage(`Error: git branch -m failed: ${mv.stderr}`);
		return;
	}

	// Step 2: state-branch side (only when toggle on)
	const projectId = readProjectIdFile(root);
	if (isStateBranchEnabledForRoot(root)) {
		const oldStateBranch = stateBranchName(oldCodeBranch);
		if (localBranchExists(root, oldStateBranch)) {
			if (projectId) {
				// Ensure repo-state reflects the OLD code branch so runStateRename
				// can identify the source. ensureStateBranch would have recorded it,
				// but guard against a fresh context.
				writeRepoState(projectId, { lastKnownCodeBranch: oldCodeBranch });
			}
			await runStateRename(pi, ctx, uiCtx, [newCodeBranch]);
		} else if (projectId) {
			writeRepoState(projectId, { lastKnownCodeBranch: newCodeBranch });
		}
	} else if (projectId) {
		writeRepoState(projectId, { lastKnownCodeBranch: newCodeBranch });
	}

	// Step 3: remote code-branch cleanup with agent-mediated prompt
	if (hasOriginRemote(root) && remoteBranchExists(root, oldCodeBranch)) {
		runGit(root, ["push", "-u", "origin", newCodeBranch]);
		pi.sendUserMessage(
			[
				`Pushed ${newCodeBranch} to origin.`,
				"",
				`The old remote branch origin/${oldCodeBranch} still exists.`,
				"Ask the user whether to delete it using tff_ask_user with:",
				'  id: "branch_rename_delete_remote"',
				'  header: "Delete remote"',
				`  question: "Delete origin/${oldCodeBranch}? (Not safe if it is the head of an open PR.)"`,
				"  options:",
				'    - label: "Yes, delete it"',
				`      description: "Permanently removes origin/${oldCodeBranch} from GitHub."`,
				'    - label: "No, keep it"',
				'      description: "Leave the old remote branch; clean up via GitHub later."',
				"",
				`If the user chooses "Yes, delete it": run git push origin :${oldCodeBranch}`,
				"If deletion fails, warn the user but do not retry automatically.",
			].join("\n"),
		);
		return;
	}

	pi.sendUserMessage(`Renamed branch: ${oldCodeBranch} -> ${newCodeBranch}`);
}
