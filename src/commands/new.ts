import type Database from "better-sqlite3";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	writeArtifact,
} from "../common/artifacts.js";
import { getProject, insertMilestone, insertProject, insertSlice } from "../common/db.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface NewProjectInput {
	projectName: string;
	vision: string;
	milestoneName: string;
	slices: string[];
}

export function handleNew(
	db: Database.Database,
	root: string,
	input: NewProjectInput,
): { projectId: string; milestoneId: string } {
	const existing = getProject(db);
	if (existing) {
		throw new Error("Project already exists. Use /tff new-milestone to add milestones.");
	}

	const { projectName, vision, milestoneName, slices } = input;

	initTffDirectory(root);

	const projectId = insertProject(db, { name: projectName, vision });

	writeArtifact(root, "PROJECT.md", `# ${projectName}\n\n## Vision\n\n${vision}\n`);

	const milestoneId = insertMilestone(db, {
		projectId,
		number: 1,
		name: milestoneName,
		branch: "milestone/M01",
	});

	initMilestoneDir(root, 1);

	writeArtifact(
		root,
		`milestones/${milestoneLabel(1)}/REQUIREMENTS.md`,
		`# ${milestoneName} — Requirements\n\n<!-- Add requirements here -->\n`,
	);

	for (const [i, title] of slices.entries()) {
		const sliceNumber = i + 1;
		insertSlice(db, { milestoneId, number: sliceNumber, title });
		initSliceDir(root, 1, sliceNumber);
		writeArtifact(
			root,
			`milestones/${milestoneLabel(1)}/slices/${sliceLabel(1, sliceNumber)}/.keep`,
			"",
		);
	}

	return { projectId, milestoneId };
}
