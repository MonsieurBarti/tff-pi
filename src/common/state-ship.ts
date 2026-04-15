import { execFileSync } from "node:child_process";
import { gitEnv } from "./git.js";
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

interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): ExecResult {
	try {
		const stdout = execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf-8",
			stdio: "pipe",
			env: gitEnv(),
		});
		return { ok: true, stdout: stdout.toString(), stderr: "" };
	} catch (err) {
		const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
		return {
			ok: false,
			stdout: e.stdout?.toString() ?? "",
			stderr: e.stderr?.toString() ?? "",
		};
	}
}

function localBranchExists(repoRoot: string, branch: string): boolean {
	return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function remoteBranchExists(repoRoot: string, branch: string): boolean {
	const r = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch]);
	if (!r.ok) return false;
	return r.stdout.trim().length > 0;
}

function hasOriginRemote(repoRoot: string): boolean {
	const r = runGit(repoRoot, ["remote"]);
	if (!r.ok) return false;
	return r.stdout
		.split("\n")
		.map((s) => s.trim())
		.includes("origin");
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
