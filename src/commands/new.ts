import type Database from "better-sqlite3";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	writeArtifact,
} from "../common/artifacts.js";
import {
	getMilestones,
	getProject,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../common/db.js";
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
	// 1. Check if project already exists
	const existing = getProject(db);
	if (existing) {
		throw new Error("Project already exists. Use /tff new-milestone to add milestones.");
	}

	const { projectName, vision, milestoneName, slices } = input;

	// 2. Initialize .tff directory structure
	initTffDirectory(root);

	// 3. Insert project
	insertProject(db, { name: projectName, vision });
	const project = getProject(db);
	if (!project) {
		throw new Error("Failed to retrieve project after insertion.");
	}

	// 4. Write PROJECT.md
	writeArtifact(root, "PROJECT.md", `# ${projectName}\n\n## Vision\n\n${vision}\n`);

	// 5. Insert milestone M01
	insertMilestone(db, {
		projectId: project.id,
		number: 1,
		name: milestoneName,
		branch: "milestone/M01",
	});
	const milestones = getMilestones(db, project.id);
	const milestone = milestones[0];
	if (!milestone) {
		throw new Error("Failed to retrieve milestone after insertion.");
	}

	// 6. Initialize milestone directory
	initMilestoneDir(root, 1);

	// 7. Write REQUIREMENTS.md placeholder
	writeArtifact(
		root,
		`milestones/${milestoneLabel(1)}/REQUIREMENTS.md`,
		`# ${milestoneName} — Requirements\n\n<!-- Add requirements here -->\n`,
	);

	// 8. For each slice: insert + init dir + write .keep placeholder
	for (let i = 0; i < slices.length; i++) {
		const sliceNumber = i + 1;
		const title = slices[i]!;
		insertSlice(db, { milestoneId: milestone.id, number: sliceNumber, title });
		initSliceDir(root, 1, sliceNumber);
		writeArtifact(
			root,
			`milestones/${milestoneLabel(1)}/slices/${sliceLabel(1, sliceNumber)}/.keep`,
			"",
		);
	}

	return { projectId: project.id, milestoneId: milestone.id };
}
