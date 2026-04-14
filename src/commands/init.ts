import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { initTffDirectory } from "../common/artifacts.js";
import type { TffContext } from "../common/context.js";
import { applyMigrations, openDatabase } from "../common/db.js";
import { ensureGitignoreEntries, getGitRoot, gitEnv, initRepo } from "../common/git.js";
import {
	ProjectHomeError,
	createTffSymlink,
	ensureProjectHomeDir,
	readProjectIdFile,
	writeProjectIdFile,
} from "../common/project-home.js";

function stageFiles(repoRoot: string, files: string[]): void {
	execFileSync("git", ["add", "--", ...files], {
		cwd: repoRoot,
		stdio: "pipe",
		env: gitEnv(),
	});
}

export interface InitResult {
	projectId: string;
	projectHome: string;
	created: boolean;
}

export function handleInit(repoRoot: string): InitResult {
	if (process.platform === "win32") {
		throw new ProjectHomeError(
			"Windows support lands in M11 (requires Developer Mode for symlinks). " +
				"TFF currently supports macOS and Linux.",
		);
	}

	const existingId = readProjectIdFile(repoRoot);
	const projectId = existingId ?? randomUUID();
	const created = existingId === null;

	const home = ensureProjectHomeDir(projectId);
	createTffSymlink(repoRoot, projectId);
	if (created) writeProjectIdFile(repoRoot, projectId);
	initTffDirectory(repoRoot);
	ensureGitignoreEntries(repoRoot);

	const dbPath = join(home, "state.db");
	const db = openDatabase(dbPath);
	try {
		applyMigrations(db, { root: repoRoot });
	} finally {
		db.close();
	}

	if (created) stageFiles(repoRoot, [".tff-project-id", ".gitignore"]);

	return { projectId, projectHome: home, created };
}

export async function runInit(
	_pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	_args: string[],
): Promise<void> {
	let root = getGitRoot() ?? process.cwd();
	if (getGitRoot() === null) {
		initRepo(root);
		root = getGitRoot() ?? root;
	}
	const result = handleInit(root);
	ctx.projectRoot = root;

	const tffHome = process.env.TFF_HOME;
	const homeNote = tffHome ? ` (TFF_HOME=${tffHome})` : "";
	const verb = result.created ? "Initialized" : "Re-validated";
	console.log(`${verb} TFF project ${result.projectId}${homeNote}`);
	console.log(`Project home: ${result.projectHome}`);
	console.log(`Symlink:      ${root}/.tff → ${result.projectHome}`);
	if (result.created) {
		console.log("Staged: .tff-project-id + .gitignore (commit when ready)");
	}
}
