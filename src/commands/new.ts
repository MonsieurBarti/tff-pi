import type Database from "better-sqlite3";
import { initTffDirectory, writeArtifact } from "../common/artifacts.js";
import { getProject, insertProject } from "../common/db.js";

export interface NewProjectInput {
	projectName: string;
	vision: string;
}

export function handleNew(
	db: Database.Database,
	root: string,
	input: NewProjectInput,
): { projectId: string } {
	const existing = getProject(db);
	if (existing) {
		throw new Error("Project already exists. Use /tff new-milestone to add milestones.");
	}
	const { projectName, vision } = input;
	initTffDirectory(root);
	const projectId = insertProject(db, { name: projectName, vision });
	writeArtifact(root, "PROJECT.md", `# ${projectName}\n\n## Vision\n\n${vision}\n`);
	return { projectId };
}
