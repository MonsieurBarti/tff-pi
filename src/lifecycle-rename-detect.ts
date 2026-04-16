import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
	hasOriginRemote,
	localBranchExists,
	remoteBranchExists,
	runGit,
} from "./common/git-internal.js";
import { readRepoState, writeRepoState } from "./common/repo-state.js";
import { readLock } from "./common/session-lock.js";
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

export type AutoDetectAlertResult =
	| "skipped-disabled"
	| "skipped-auto-detect-off"
	| "skipped-locked"
	| "no-change"
	| "not-a-rename"
	| "alerted";

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
	const settingsPath = join(root, ".tff", "settings.yaml");
	let raw: string;
	try {
		raw = readFileSync(settingsPath, "utf-8");
	} catch {
		raw = "";
	}

	// Parse as a YAML document so we can mutate without losing unknown keys.
	const doc = raw.trim().length > 0 ? YAML.parseDocument(raw) : new YAML.Document({});

	// Ensure state_branch mapping exists, then set auto_detect_rename: false.
	doc.setIn(["state_branch", "auto_detect_rename"], false);

	// Atomic write: tmp + rename.
	const tmp = `${settingsPath}.tmp`;
	writeFileSync(tmp, doc.toString(), "utf-8");
	renameSync(tmp, settingsPath);
}

/**
 * Full decision-tree rename handler used by unit tests.
 *
 * @internal Production alert path uses `detectRenameAlert` instead.
 */
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

/**
 * Alert-only rename detection used in the session_start preflight.
 *
 * Detects a true rename candidate and emits an informational message via
 * `emit` (e.g. `pi.sendUserMessage`). Updates repo-state so the alert does
 * not re-fire on the next command. Never renames the state branch itself —
 * that requires an explicit `/tff state rename <branch>` command.
 */
export async function detectRenameAlert(
	root: string,
	projectId: string,
	emit: (message: string) => void,
): Promise<AutoDetectAlertResult> {
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

	// True rename candidate — alert and record, do NOT rename state.
	emit(
		[
			`Detected branch rename: ${repoState.lastKnownCodeBranch} -> ${current}.`,
			"",
			`The state branch tff-state/${repoState.lastKnownCodeBranch} was NOT renamed automatically. To sync the state`,
			"branch with the new code branch name, run:",
			`  /tff state rename ${current}`,
			"",
			"Or to disable this alert permanently for future renames:",
			"  Set state_branch.auto_detect_rename: false in settings.yaml",
		].join("\n"),
	);
	writeRepoState(projectId, { lastKnownCodeBranch: current });
	return "alerted";
}
