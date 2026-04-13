import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { initTffDirectory, tffPath, writeArtifact } from "../common/artifacts.js";
import { compressIfEnabled } from "../common/compress.js";
import type { TffContext } from "../common/context.js";
import { applyMigrations, getProject, insertProject, openDatabase } from "../common/db.js";
import { createGitignore, getGitRoot, hasRemote, initRepo } from "../common/git.js";
import { DEFAULT_SETTINGS, type Settings, loadSettings } from "../common/settings.js";

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

function initDb(ctx: TffContext, root: string): void {
	initTffDirectory(root);
	const dbPath = tffPath(root, "state.db");
	ctx.db = openDatabase(dbPath);
	applyMigrations(ctx.db);
}

export async function runNew(
	pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	let root = getGitRoot() ?? ctx.projectRoot;
	if (!root) {
		initRepo(process.cwd());
		root = getGitRoot() ?? process.cwd();
	}
	createGitignore(root);
	ctx.projectRoot = root;
	initDb(ctx, root);
	loadSettings(ctx, root);

	const projectName = args[0] ?? "New Project";
	const remoteInstruction = hasRemote(root)
		? ""
		: "\n\nIMPORTANT: No git remote is configured. Ask the user for their GitHub repository URL and call the tff_add_remote tool with it. This is required for the ship phase to create PRs.";
	pi.sendUserMessage(
		`You are setting up a new TFF project. The user wants to create a project called "${projectName}".\n\nPlease help them brainstorm:\n1. A clear vision statement for the project\n\nOnce agreed, call the tff_create_project tool with the project name and vision. After creating the project, suggest the user run /tff new-milestone.${remoteInstruction}`,
	);
}
