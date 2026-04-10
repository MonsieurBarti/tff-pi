import type Database from "better-sqlite3";
import { initMilestoneDir, writeArtifact } from "../common/artifacts.js";
import { getNextMilestoneNumber, insertMilestone } from "../common/db.js";
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
	writeArtifact(
		root,
		`milestones/${label}/REQUIREMENTS.md`,
		`# ${name} — Requirements\n\n<!-- Requirements will be brainstormed by the agent -->\n`,
	);
	return { milestoneId, number, branch };
}
