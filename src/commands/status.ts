import type Database from "better-sqlite3";
import { getMilestones, getPhaseRuns, getProject, getSlices } from "../common/db.js";
import { formatDuration } from "../common/format.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

const NO_PROJECT_MSG = "No project found. Run `/tff new` to create one.";

import type { SliceStatus } from "../common/types.js";

const NEXT_ACTION_COMMAND: Partial<Record<SliceStatus, string>> = {
	created: "discuss",
	discussing: "discuss",
	researching: "research",
	planning: "plan",
	executing: "execute",
	verifying: "verify",
	reviewing: "review",
	shipping: "ship",
};

export function handleStatus(db: Database.Database): string {
	const project = getProject(db);
	if (!project) return NO_PROJECT_MSG;

	const lines: string[] = [`# ${project.name}`, ""];

	const milestones = getMilestones(db, project.id);

	let firstNonClosed: { milestoneNumber: number; sliceNumber: number; status: SliceStatus } | null =
		null;

	for (const milestone of milestones) {
		const mLabel = milestoneLabel(milestone.number);
		lines.push(`## ${mLabel} — ${milestone.name} \`[${milestone.status}]\``);

		const slices = getSlices(db, milestone.id);
		for (const slice of slices) {
			const sLabel = sliceLabel(milestone.number, slice.number);
			const tier = slice.tier ? ` | Tier: ${slice.tier}` : "";
			lines.push(`- **${sLabel}** ${slice.title} \`[${slice.status}]\`${tier}`);

			const runs = getPhaseRuns(db, slice.id);
			if (runs.length > 0) {
				const completedCount = runs.filter((r) => r.status === "completed").length;
				const totalPhases = runs.length;
				const totalMs = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
				const durStr = totalMs > 0 ? `, ${formatDuration(totalMs)} total` : "";
				lines.push(`  ${completedCount}/${totalPhases} phases${durStr}`);
			}

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
