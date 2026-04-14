import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { initTffDirectory } from "../common/artifacts.js";
import type { TffContext } from "../common/context.js";
import { ensureGitignoreEntries, getGitRoot, initRepo } from "../common/git.js";
import {
	ProjectHomeError,
	createTffSymlink,
	ensureProjectHomeDir,
	readProjectIdFile,
	writeProjectIdFile,
} from "../common/project-home.js";

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
		console.log("Created: .tff-project-id + .gitignore (review and commit when ready)");
	}
}
