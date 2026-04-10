import type Database from "better-sqlite3";
import { getMilestones, getProject, getSlices, getTasks } from "../common/db.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

const NO_PROJECT_MSG = "No project found. Run `/tff new` to create one.";

export function handleProgress(db: Database.Database): string {
	const project = getProject(db);
	if (!project) return NO_PROJECT_MSG;

	const lines: string[] = [`# ${project.name} — Progress`, ""];

	const milestones = getMilestones(db, project.id);

	for (const milestone of milestones) {
		const mLabel = milestoneLabel(milestone.number);
		const slices = getSlices(db, milestone.id);
		const closedSlices = slices.filter((s) => s.status === "closed").length;
		const totalSlices = slices.length;

		lines.push(`## ${mLabel} — ${milestone.name} (${closedSlices}/${totalSlices} slices closed)`);
		lines.push("");

		if (slices.length > 0) {
			lines.push("| Slice | Title | Status | Tier | Tasks |");
			lines.push("| --- | --- | --- | --- | --- |");

			for (const slice of slices) {
				const sLabel = sliceLabel(milestone.number, slice.number);
				const tier = slice.tier ?? "—";
				const tasks = getTasks(db, slice.id);
				const taskCount =
					tasks.length === 0
						? "—"
						: `${tasks.filter((t) => t.status === "closed").length}/${tasks.length}`;
				lines.push(`| ${sLabel} | ${slice.title} | ${slice.status} | ${tier} | ${taskCount} |`);
			}
		}

		lines.push("");
	}

	return lines.join("\n").trimEnd();
}
