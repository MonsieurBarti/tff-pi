import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isValidBranchName } from "../common/branch-names.js";
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
import type { Question } from "../tools/ask-user/interview-ui.js";
import { showInterviewRound } from "../tools/ask-user/interview-ui.js";
import { runStateRename } from "./state-rename.js";

function currentBranch(repoRoot: string): string | null {
	const r = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!r.ok) return null;
	const b = r.stdout.trim();
	return b === "HEAD" ? null : b;
}

/**
 * Injectable seam for the remote-delete prompt.
 * Returns "Yes" | "No" when the user makes a choice, or "skip" when headless.
 * Defaults to the real showInterviewRound-backed implementation; tests inject
 * their own to avoid TUI rendering.
 */
export type PromptDeleteRemote = (
	uiCtx: ExtensionCommandContext | null,
	oldCodeBranch: string,
) => Promise<"Yes" | "No" | "skip">;

async function defaultPromptDeleteRemote(
	uiCtx: ExtensionCommandContext | null,
	oldCodeBranch: string,
): Promise<"Yes" | "No" | "skip"> {
	if (!uiCtx?.ui?.custom) return "skip";

	const question: Question = {
		id: "branch_rename_delete_remote",
		header: "Delete remote?",
		question: `Delete origin/${oldCodeBranch}? Not safe if it is the head of an open PR.`,
		options: [
			{
				label: "Yes",
				description: `Permanently removes origin/${oldCodeBranch} from the remote.`,
			},
			{
				label: "No",
				description: "Leave the old remote branch; clean up via GitHub UI later.",
			},
		],
	};

	// showInterviewRound expects ExtensionContext; ExtensionCommandContext satisfies
	// that shape (it has ui.custom). The cast avoids a fragile structural import.
	const result = await showInterviewRound(
		[question],
		{},
		uiCtx as unknown as Parameters<typeof showInterviewRound>[2],
	);

	const selected = result.answers.branch_rename_delete_remote?.selected;
	const label = Array.isArray(selected) ? selected[0] : selected;
	return label === "Yes" ? "Yes" : "No";
}

export interface RunBranchRenameOpts {
	/** Override the remote-delete prompt (used in tests). */
	promptDeleteRemote?: PromptDeleteRemote;
}

export async function runBranchRename(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
	opts: RunBranchRenameOpts = {},
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
	if (!isValidBranchName(newCodeBranch)) {
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
			await runStateRename(pi, ctx, uiCtx, [newCodeBranch], { sourceCodeBranch: oldCodeBranch });
		} else if (projectId) {
			writeRepoState(projectId, { lastKnownCodeBranch: newCodeBranch });
		}
	} else if (projectId) {
		writeRepoState(projectId, { lastKnownCodeBranch: newCodeBranch });
	}

	// Step 3: remote code-branch cleanup with blocking prompt
	if (hasOriginRemote(root) && remoteBranchExists(root, oldCodeBranch)) {
		// Publish new branch first (best-effort)
		runGit(root, ["push", "-u", "origin", newCodeBranch]);

		const prompt = opts.promptDeleteRemote ?? defaultPromptDeleteRemote;
		let choice: "Yes" | "No" | "skip";
		try {
			choice = await prompt(uiCtx, oldCodeBranch);
		} catch (err) {
			pi.sendUserMessage(
				`Warning: could not render delete-prompt UI (${String(err)}); keeping origin/${oldCodeBranch}.`,
			);
			choice = "skip";
		}

		if (choice === "Yes") {
			const del = runGit(root, ["push", "origin", `:${oldCodeBranch}`]);
			if (!del.ok) {
				pi.sendUserMessage(`Warning: could not delete origin/${oldCodeBranch}: ${del.stderr}`);
			} else {
				pi.sendUserMessage(`Deleted origin/${oldCodeBranch}.`);
			}
		} else if (choice === "No") {
			pi.sendUserMessage(`Left origin/${oldCodeBranch} in place (user declined).`);
		} else {
			pi.sendUserMessage(
				`Left origin/${oldCodeBranch} in place (headless session; no prompt available).`,
			);
		}
	}

	pi.sendUserMessage(`Renamed branch: ${oldCodeBranch} -> ${newCodeBranch}`);
}
