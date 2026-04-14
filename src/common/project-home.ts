import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, serializeSettings } from "./settings.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectHomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectHomeError";
	}
}

export function tffHomeRoot(): string {
	const override = process.env.TFF_HOME;
	if (!override || override.length === 0) return join(homedir(), ".tff");
	if (override.includes("\0")) {
		throw new ProjectHomeError("TFF_HOME contains null byte");
	}
	if (!override.startsWith("/")) {
		throw new ProjectHomeError(`TFF_HOME must be an absolute path, got: ${override}`);
	}
	return override;
}

export function isUuidV4(s: string): boolean {
	return UUID_V4_RE.test(s);
}

export function projectHomeDir(projectId: string): string {
	return join(tffHomeRoot(), projectId);
}

export function ensureProjectHomeDir(projectId: string): string {
	const dir = projectHomeDir(projectId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	mkdirSync(join(dir, "milestones"), { recursive: true });
	mkdirSync(join(dir, "worktrees"), { recursive: true });
	const settingsPath = join(dir, "settings.yaml");
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, serializeSettings(DEFAULT_SETTINGS), "utf-8");
	}
	return dir;
}

export function createTffSymlink(repoRoot: string, projectId: string): void {
	const linkPath = join(repoRoot, ".tff");
	const target = projectHomeDir(projectId);
	if (existsSync(linkPath) || isSymlink(linkPath)) {
		const stat = lstatSync(linkPath);
		if (!stat.isSymbolicLink()) {
			throw new ProjectHomeError(
				".tff/ exists as a real directory. TFF M10 centralizes state to ~/.tff/{projectId}/.\n" +
					"Before re-initializing:\n" +
					"  1. Back up .tff/ if you want to preserve its contents\n" +
					"  2. rm -rf .tff/\n" +
					"  3. Re-run /tff init",
			);
		}
		const actual = readlinkSync(linkPath);
		if (actual !== target) {
			throw new ProjectHomeError(
				`.tff/ symlink points to ${actual} but expected ${target}. Run: rm .tff && /tff init`,
			);
		}
		return;
	}
	symlinkSync(target, linkPath, "dir");
}

export function projectIdFilePath(repoRoot: string): string {
	return join(repoRoot, ".tff-project-id");
}

export function readProjectIdFile(repoRoot: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(projectIdFilePath(repoRoot), "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const trimmed = raw.trim();
	if (!isUuidV4(trimmed)) {
		throw new ProjectHomeError(
			`.tff-project-id does not contain a valid UUID v4: ${trimmed.slice(0, 40)}…`,
		);
	}
	return trimmed;
}

export function writeProjectIdFile(repoRoot: string, projectId: string): void {
	writeFileSync(projectIdFilePath(repoRoot), `${projectId}\n`, "utf-8");
}

/** Returns true for both dangling and non-dangling symlinks. */
function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function resolveMergeDriverPath(): string {
	// project-home.ts compiles to dist/common/project-home.js; the merge-driver
	// bin lives at dist/tools/state-snapshot-merge.js. During tests, import.meta.url
	// points into src/, so the same relative resolution picks up the .ts source,
	// which bun can run directly.
	const url = new URL("../tools/state-snapshot-merge.js", import.meta.url);
	return decodeURIComponent(url.pathname);
}

function expectedDriverCommand(): string {
	const path = resolveMergeDriverPath().replace(/'/g, `'\\''`);
	return `node '${path}' %O %A %B %P`;
}

export function ensureSnapshotMergeDriver(repoRoot: string): void {
	const expected = expectedDriverCommand();
	let current: string | undefined;
	try {
		current = execFileSync(
			"git",
			["-C", repoRoot, "config", "--local", "--get", "merge.tff-snapshot.driver"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		current = undefined;
	}
	if (current === expected) return;
	execFileSync(
		"git",
		[
			"-C",
			repoRoot,
			"config",
			"--local",
			"merge.tff-snapshot.name",
			"TFF state snapshot 3-way merge",
		],
		{ stdio: "ignore" },
	);
	execFileSync(
		"git",
		["-C", repoRoot, "config", "--local", "merge.tff-snapshot.driver", expected],
		{ stdio: "ignore" },
	);
}
