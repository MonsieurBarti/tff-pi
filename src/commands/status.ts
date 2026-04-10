import type Database from "better-sqlite3";
import { getMilestones, getProject, getSlices } from "../common/db.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

const NO_PROJECT_MSG = "No project found. Run `/tff new` to create one.";

const NEXT_ACTION_COMMAND: Record<string, string> = {
	created: "discuss",
	discussing: "discuss",
	researching: "research",
	planning: "plan",
	executing: "execute",
	verifying: "verify",
	reviewing: "review",
	shipping: "ship",
	paused: "discuss",
};

export function handleStatus(db: Database.Database): string {
	const project = getProject(db);
	if (!project) return NO_PROJECT_MSG;

	const lines: string[] = [`# ${project.name}`, ""];

	const milestones = getMilestones(db, project.id);

	let firstNonClosed: { milestoneNumber: number; sliceNumber: number; status: string } | null =
		null;

	for (const milestone of milestones) {
		const mLabel = milestoneLabel(milestone.number);
		lines.push(`## ${mLabel} — ${milestone.name} \`[${milestone.status}]\``);

		const slices = getSlices(db, milestone.id);
		for (const slice of slices) {
			const sLabel = sliceLabel(milestone.number, slice.number);
			const tier = slice.tier ? ` | Tier: ${slice.tier}` : "";
			lines.push(`- **${sLabel}** ${slice.title} \`[${slice.status}]\`${tier}`);

			if (!firstNonClosed && slice.status !== "closed") {
				firstNonClosed = {
					milestoneNumber: milestone.number,
					sliceNumber: slice.number,
					status: slice.status,
				};
			}
		}

		lines.push("");
	}

	if (firstNonClosed) {
		const label = sliceLabel(firstNonClosed.milestoneNumber, firstNonClosed.sliceNumber);
		const cmd = NEXT_ACTION_COMMAND[firstNonClosed.status] ?? "discuss";
		lines.push(`**Suggested next action:** \`/tff ${cmd} ${label}\``);
	}

	return lines.join("\n").trimEnd();
}
