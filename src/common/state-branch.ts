import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export class StateBranchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateBranchError";
	}
}

export function stateBranchName(codeBranch: string): string {
	return `tff-state/${codeBranch}`;
}

const EXCLUDED_TOP = new Set<string>([
	".tmp",
	"worktrees",
	"logs",
	".gitconfig",
	"repo-path",
	"repo-state.json",
	"session.lock",
	"pending-phase-message.txt",
]);

function isExcludedPath(relPath: string): boolean {
	// top-level excludes
	const first = relPath.split("/")[0] ?? "";
	if (EXCLUDED_TOP.has(first)) return true;
	// state.db and sidecars (state.db, state.db-journal, state.db-wal, state.db-shm)
	if (relPath === "state.db" || relPath.startsWith("state.db-")) return true;
	return false;
}

export function mirrorPortableSubset(homeDir: string, worktreeDir: string): void {
	const homeReal = realpathSync(homeDir);
	walk(homeReal, homeReal, worktreeDir);
}

function walk(homeReal: string, currentAbs: string, destRoot: string): void {
	const entries = readdirSync(currentAbs, { withFileTypes: true });
	for (const entry of entries) {
		const absPath = join(currentAbs, entry.name);
		const relPath = relative(homeReal, absPath);
		if (isExcludedPath(relPath)) continue;
		// Path-traversal guard: resolved real path must stay inside homeReal.
		let resolved: string;
		try {
			resolved = realpathSync(absPath);
		} catch {
			continue;
		}
		const rel = relative(homeReal, resolved);
		if (rel.startsWith("..") || rel.startsWith("/")) continue;

		const destAbs = join(destRoot, relPath);
		const stat = lstatSync(absPath);
		if (stat.isDirectory()) {
			mkdirSync(destAbs, { recursive: true });
			walk(homeReal, absPath, destRoot);
		} else if (stat.isFile() || stat.isSymbolicLink()) {
			mkdirSync(dirname(destAbs), { recursive: true });
			copyFileSync(resolved, destAbs);
		}
	}
}
