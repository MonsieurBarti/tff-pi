import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidBranchName } from "./branch-names.js";
import { logWarning } from "./logger.js";
import { projectHomeDir } from "./project-home.js";

export interface RepoState {
	lastKnownCodeBranch: string;
	lastKnownCodeBranchSeenAt: string;
}

function repoStatePath(projectId: string): string {
	return join(projectHomeDir(projectId), "repo-state.json");
}

export function readRepoState(projectId: string): RepoState | null {
	const p = repoStatePath(projectId);
	if (!existsSync(p)) return null;
	let raw: string;
	try {
		raw = readFileSync(p, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed.lastKnownCodeBranch === "string" &&
			typeof parsed.lastKnownCodeBranchSeenAt === "string" &&
			isValidBranchName(parsed.lastKnownCodeBranch)
		) {
			return parsed as RepoState;
		}
		return null;
	} catch {
		logWarning("state-branch", "repo-state-malformed", { id: p });
		return null;
	}
}

export function writeRepoState(projectId: string, state: { lastKnownCodeBranch: string }): void {
	if (!isValidBranchName(state.lastKnownCodeBranch)) {
		throw new Error(
			`writeRepoState: invalid branch name ${JSON.stringify(state.lastKnownCodeBranch)}`,
		);
	}
	const full: RepoState = {
		lastKnownCodeBranch: state.lastKnownCodeBranch,
		lastKnownCodeBranchSeenAt: new Date().toISOString(),
	};
	const p = repoStatePath(projectId);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`, "utf-8");
	renameSync(tmp, p); // atomic
}
