import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SETTINGS, serializeSettings } from "./settings.js";
import { milestoneLabel, sliceLabel } from "./types.js";

export function tffPath(root: string, ...segments: string[]): string {
	return join(root, ".tff", ...segments);
}

function safeTffPath(root: string, relativePath: string): string {
	const tffRoot = resolve(root, ".tff");
	const fullPath = resolve(tffRoot, relativePath);
	if (fullPath !== tffRoot && !fullPath.startsWith(`${tffRoot}/`)) {
		throw new Error(`Path traversal detected: ${relativePath}`);
	}
	return fullPath;
}

export function milestoneDir(root: string, milestoneNumber: number): string {
	return tffPath(root, "milestones", milestoneLabel(milestoneNumber));
}

export function sliceDir(root: string, milestoneNumber: number, sliceNumber: number): string {
	return tffPath(
		root,
		"milestones",
		milestoneLabel(milestoneNumber),
		"slices",
		sliceLabel(milestoneNumber, sliceNumber),
	);
}

export function initTffDirectory(root: string): void {
	// .tff/ itself is owned by handleInit (symlink to ~/.tff/{projectId}/).
	// This function only initializes the subdirs and settings.yaml through the
	// symlink. It is a no-op if the symlink (or dir) doesn't exist yet, so
	// handleInit can safely call it after creating the symlink.
	const tffRoot = tffPath(root);
	if (!existsSync(tffRoot)) return;
	mkdirSync(tffPath(root, "milestones"), { recursive: true });
	mkdirSync(tffPath(root, "worktrees"), { recursive: true });
	const settingsPath = tffPath(root, "settings.yaml");
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, serializeSettings(DEFAULT_SETTINGS), "utf-8");
	}
}

export function writeArtifact(root: string, relativePath: string, content: string): void {
	const fullPath = safeTffPath(root, relativePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content, "utf-8");
}

export function deleteArtifact(root: string, relativePath: string): void {
	const fullPath = safeTffPath(root, relativePath);
	if (existsSync(fullPath)) {
		rmSync(fullPath, { force: true });
	}
}

export function readArtifact(root: string, relativePath: string): string | null {
	const fullPath = safeTffPath(root, relativePath);
	try {
		return readFileSync(fullPath, "utf-8");
	} catch {
		return null;
	}
}

export function artifactExists(root: string, relativePath: string): boolean {
	return existsSync(safeTffPath(root, relativePath));
}

export function initMilestoneDir(root: string, milestoneNumber: number): void {
	mkdirSync(milestoneDir(root, milestoneNumber), { recursive: true });
}

export function initSliceDir(root: string, milestoneNumber: number, sliceNumber: number): void {
	mkdirSync(sliceDir(root, milestoneNumber, sliceNumber), { recursive: true });
}
