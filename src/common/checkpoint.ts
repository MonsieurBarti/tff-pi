import { execFileSync } from "node:child_process";
import { gitEnv } from "./git.js";

function tagName(sliceLabel: string, name: string): string {
	return `checkpoint/${sliceLabel}/${name}`;
}

export function createCheckpoint(cwd: string, sliceLabel: string, name: string): void {
	const tag = tagName(sliceLabel, name);
	const env = gitEnv();
	// Use -f to overwrite if exists (idempotent)
	execFileSync("git", ["tag", "-f", tag], { cwd, encoding: "utf-8", env, stdio: "pipe" });
}

export function listCheckpoints(cwd: string, sliceLabel: string): string[] {
	const env = gitEnv();
	const prefix = `checkpoint/${sliceLabel}/`;
	try {
		const output = execFileSync("git", ["tag", "-l", `${prefix}*`], {
			cwd,
			encoding: "utf-8",
			env,
			stdio: "pipe",
		}).trim();
		if (!output) return [];
		return output.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export function getLastCheckpoint(cwd: string, sliceLabel: string): string | null {
	const env = gitEnv();
	const refFilter = `refs/tags/checkpoint/${sliceLabel}/`;
	try {
		// Walk the DAG in commit order and find the first (most recent) matching tag.
		// This is more reliable than --sort=-creatordate which uses commit timestamps
		// and can tie when commits happen within the same second.
		const output = execFileSync("git", ["log", `--decorate-refs=${refFilter}`, "--pretty=%D"], {
			cwd,
			encoding: "utf-8",
			env,
			stdio: "pipe",
		}).trim();
		if (!output) return null;
		const firstTagLine = output.split("\n").filter(Boolean)[0];
		if (!firstTagLine) return null;
		// %D produces "tag: checkpoint/slice/name" — strip "tag: " prefix
		const tag = firstTagLine.replace(/^tag:\s*/, "");
		return tag || null;
	} catch {
		return null;
	}
}

export function cleanupCheckpoints(cwd: string, sliceLabel: string): void {
	const tags = listCheckpoints(cwd, sliceLabel);
	if (tags.length === 0) return;
	const env = gitEnv();
	execFileSync("git", ["tag", "-d", ...tags], { cwd, encoding: "utf-8", env, stdio: "pipe" });
}
