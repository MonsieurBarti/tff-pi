import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readArtifact } from "./common/artifacts.js";
import {
	hasOriginRemote,
	localBranchExists,
	remoteBranchExists,
	runGit,
} from "./common/git-internal.js";
import { readRepoState, writeRepoState } from "./common/repo-state.js";
import { readLock } from "./common/session-lock.js";
import { parseSettings, serializeSettings } from "./common/settings.js";
import {
	isAutoDetectRenameEnabled,
	isStateBranchEnabledForRoot,
} from "./common/state-branch-toggle.js";
import { stateBranchName } from "./common/state-branch.js";

export type AutoDetectResult =
	| "skipped-disabled"
	| "skipped-auto-detect-off"
	| "skipped-locked"
	| "no-change"
	| "not-a-rename"
	| "renamed"
	| "declined"
	| "never";

export type AutoDetectAskUser = (
	old: string,
	current: string,
) => Promise<"Yes" | "No" | "Never ask" | string | null>;

function currentBranch(root: string): string | null {
	const r = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!r.ok) return null;
	const b = r.stdout.trim();
	return b === "HEAD" ? null : b;
}

function branchExistsAnywhere(root: string, branch: string): boolean {
	if (localBranchExists(root, branch)) return true;
	if (hasOriginRemote(root) && remoteBranchExists(root, branch)) return true;
	return false;
}

function writeAutoDetectOff(root: string): void {
	const yaml = readArtifact(root, "settings.yaml") ?? "";
	const parsed = parseSettings(yaml);
	parsed.state_branch.auto_detect_rename = false;
	const p = join(root, ".tff", "settings.yaml");
	writeFileSync(p, serializeSettings(parsed), "utf-8");
}

export async function detectAndHandleRename(
	root: string,
	projectId: string,
	ask: AutoDetectAskUser,
): Promise<AutoDetectResult> {
	if (!isStateBranchEnabledForRoot(root)) return "skipped-disabled";
	if (!isAutoDetectRenameEnabled(root)) return "skipped-auto-detect-off";

	const lock = readLock(root);
	if (lock) return "skipped-locked";

	const current = currentBranch(root);
	if (!current) return "no-change";

	const repoState = readRepoState(projectId);
	if (!repoState) {
		writeRepoState(projectId, { lastKnownCodeBranch: current });
		return "no-change";
	}
	if (repoState.lastKnownCodeBranch === current) return "no-change";

	if (branchExistsAnywhere(root, repoState.lastKnownCodeBranch)) {
		writeRepoState(projectId, { lastKnownCodeBranch: current });
		return "not-a-rename";
	}

	// True rename candidate — prompt.
	const answer = await ask(repoState.lastKnownCodeBranch, current);
	if (answer === "Yes") {
		const oldStateBranch = stateBranchName(repoState.lastKnownCodeBranch);
		const newStateBranch = stateBranchName(current);
		if (localBranchExists(root, oldStateBranch)) {
			runGit(root, ["branch", "-m", oldStateBranch, newStateBranch]);
		}
		writeRepoState(projectId, { lastKnownCodeBranch: current });
		return "renamed";
	}
	if (answer === "Never ask") {
		writeAutoDetectOff(root);
		writeRepoState(projectId, { lastKnownCodeBranch: current });
		return "never";
	}
	// "No" or null or anything else: accept current, do not rename state.
	writeRepoState(projectId, { lastKnownCodeBranch: current });
	return "declined";
}
