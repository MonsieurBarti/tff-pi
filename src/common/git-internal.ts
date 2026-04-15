import { execFileSync } from "node:child_process";
import { gitEnv } from "./git.js";

export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export function runGit(cwd: string, args: string[]): ExecResult {
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

export function localBranchExists(repoRoot: string, branch: string): boolean {
	return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

export function remoteBranchExists(repoRoot: string, branch: string): boolean {
	const r = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch]);
	if (!r.ok) return false;
	return r.stdout.trim().length > 0;
}

export function hasOriginRemote(repoRoot: string): boolean {
	const r = runGit(repoRoot, ["remote"]);
	if (!r.ok) return false;
	return r.stdout
		.split("\n")
		.map((s) => s.trim())
		.includes("origin");
}
