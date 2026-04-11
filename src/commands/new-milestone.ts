import type Database from "better-sqlite3";
import { initMilestoneDir, writeArtifact } from "../common/artifacts.js";
import { getNextMilestoneNumber, insertMilestone } from "../common/db.js";
import { branchExists, createBranch, getCurrentBranch } from "../common/git.js";
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
): MilestoneResult {
	const number = getNextMilestoneNumber(db, projectId);
	const label = milestoneLabel(number);
	const branch = `milestone/${label}`;
	const milestoneId = insertMilestone(db, { projectId, number, name, branch });
	initMilestoneDir(root, number);

	// Create the milestone branch if it doesn't exist
	try {
		if (!branchExists(branch, root)) {
			const current = getCurrentBranch(root) ?? "HEAD";
			createBranch(branch, current, root);
		}
	} catch {
		// Not a git repo or git unavailable — branch will be created when needed
	}
	writeArtifact(
		root,
		`milestones/${label}/REQUIREMENTS.md`,
		`# ${name} — Requirements\n\n<!-- Requirements will be brainstormed by the agent -->\n`,
	);
	return { milestoneId, number, branch };
}
