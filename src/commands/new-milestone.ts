import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { initMilestoneDir, writeArtifact } from "../common/artifacts.js";
import { compressIfEnabled } from "../common/compress.js";
import { type TffContext, requireProject } from "../common/context.js";
import { getNextMilestoneNumber, getProject, insertMilestone } from "../common/db.js";
import { branchExists, createBranch, getCurrentBranch, pushBranch } from "../common/git.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";
import { milestoneLabel } from "../common/types.js";

export interface MilestoneResult {
	milestoneId: string;
	number: number;
	branch: string;
}

export function createMilestone(
	db: Database.Database,
	root: string,
	projectId: string,
	name: string,
	settings: Settings = DEFAULT_SETTINGS,
): MilestoneResult {
	const number = getNextMilestoneNumber(db, projectId);
	const label = milestoneLabel(number);
	const branch = `milestone/${label}`;
	const milestoneId = insertMilestone(db, { projectId, number, name, branch });
	initMilestoneDir(root, number);

	// Create the milestone branch — git repo must exist at this point
	if (!branchExists(branch, root)) {
		const current = getCurrentBranch(root) ?? "HEAD";
		createBranch(branch, current, root);
	}
	// Push the milestone branch so slice PRs can target it as base. Without
	// this, `gh pr create` fails with "Base ref must be a branch" because
	// the milestone branch only exists locally.
	pushBranch(branch, root);
	const reqContent = `# ${name} — Requirements\n\n<!-- Requirements will be brainstormed by the agent -->\n`;
	writeArtifact(
		root,
		`milestones/${label}/REQUIREMENTS.md`,
		compressIfEnabled(reqContent, "artifacts", settings),
	);
	return { milestoneId, number, branch };
}

export async function runNewMilestone(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const projectCtx = requireProject(ctx, uiCtx);
	if (!projectCtx) return;
	const { db: database, root, settings: currentSettings } = projectCtx;
	const project = getProject(database);
	if (!project) {
		if (uiCtx?.hasUI) uiCtx.ui.notify("No project found. Run /tff new first.", "error");
		return;
	}
	const milestoneName = args[0] ?? "New Milestone";
	const result = createMilestone(database, root, project.id, milestoneName, currentSettings);
	pi.sendUserMessage(
		`Milestone ${milestoneLabel(result.number)} "${milestoneName}" created on branch ${result.branch}.\n\nNow brainstorm requirements and decompose into slices. Use the tff_create_slice tool to create each slice.`,
	);
}
