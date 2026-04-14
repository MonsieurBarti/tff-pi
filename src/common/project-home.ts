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

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectHomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectHomeError";
	}
}

export function tffHomeRoot(): string {
	const override = process.env.TFF_HOME;
	if (override && override.length > 0) return override;
	return join(homedir(), ".tff");
}

export function isUuidV4(s: string): boolean {
	return UUID_V4_RE.test(s);
}

export function projectHomeDir(projectId: string): string {
	return join(tffHomeRoot(), projectId);
}

export function ensureProjectHomeDir(projectId: string): string {
	const dir = projectHomeDir(projectId);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, "milestones"), { recursive: true });
	mkdirSync(join(dir, "worktrees"), { recursive: true });
	return dir;
}

export function createTffSymlink(repoRoot: string, projectId: string): void {
	const linkPath = join(repoRoot, ".tff");
	const target = projectHomeDir(projectId);
	if (existsSync(linkPath) || isDanglingLink(linkPath)) {
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

function isDanglingLink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
