import type Database from "better-sqlite3";
import { initTffDirectory, writeArtifact } from "../common/artifacts.js";
import { compressIfEnabled } from "../common/compress.js";
import { getProject, insertProject } from "../common/db.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";

export interface NewProjectInput {
	projectName: string;
	vision: string;
}

export function handleNew(
	db: Database.Database,
	root: string,
	input: NewProjectInput,
	settings: Settings = DEFAULT_SETTINGS,
): { projectId: string } {
	const existing = getProject(db);
	if (existing) {
		throw new Error("Project already exists. Use /tff new-milestone to add milestones.");
	}
	const { projectName, vision } = input;
	initTffDirectory(root);
	const projectId = insertProject(db, { name: projectName, vision });
	const content = `# ${projectName}\n\n## Vision\n\n${vision}\n`;
	writeArtifact(root, "PROJECT.md", compressIfEnabled(content, "artifacts", settings));
	return { projectId };
}
