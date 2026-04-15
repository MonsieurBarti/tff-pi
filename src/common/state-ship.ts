import { hasOriginRemote, localBranchExists, remoteBranchExists } from "./git-internal.js";
import { stateBranchName } from "./state-branch.js";

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

export async function finalizeStateBranchForMilestone(
	opts: FinalizeOpts,
): Promise<FinalizeOutcome> {
	const { repoRoot, milestoneBranch } = opts;
	const stateBranch = stateBranchName(milestoneBranch);

	const existsLocal = localBranchExists(repoRoot, stateBranch);
	const existsRemote = hasOriginRemote(repoRoot) && remoteBranchExists(repoRoot, stateBranch);
	if (!existsLocal && !existsRemote) return "skipped-no-state-branch";

	// TODO(next tasks): final commit + merge + tag + delete
	throw new Error("not yet implemented");
}
