import type Database from "better-sqlite3";
import { getMilestones, getPhaseRuns, getProject, getSlices, getTasks } from "../common/db.js";
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
			lines.push("| Slice | Title | Status | Tier | Tasks | Phases | Time |");
			lines.push("| --- | --- | --- | --- | --- | --- | --- |");

			for (const slice of slices) {
				const sLabel = sliceLabel(milestone.number, slice.number);
				const tier = slice.tier ?? "—";
				const tasks = getTasks(db, slice.id);
				const taskCount =
					tasks.length === 0
						? "—"
						: `${tasks.filter((t) => t.status === "closed").length}/${tasks.length}`;
				const runs = getPhaseRuns(db, slice.id);
				const completedPhases = runs.filter((r) => r.status === "completed").length;
				const phaseStr = runs.length > 0 ? `${completedPhases}/${runs.length}` : "—";
				const totalMs = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
				const timeStr = totalMs > 0 ? formatDuration(totalMs) : "—";
				lines.push(
					`| ${sLabel} | ${slice.title} | ${slice.status} | ${tier} | ${taskCount} | ${phaseStr} | ${timeStr} |`,
				);
			}
		}

		lines.push("");
	}

	const allSlices = milestones.flatMap((m) => getSlices(db, m.id));
	const closedTotal = allSlices.filter((s) => s.status === "closed").length;
	const allTasks = allSlices.flatMap((s) => getTasks(db, s.id));
	const closedTasks = allTasks.filter((t) => t.status === "closed").length;
	const allRuns = allSlices.flatMap((s) => getPhaseRuns(db, s.id));
	const totalTime = allRuns.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
	lines.push(
		`Pipeline: ${closedTotal}/${allSlices.length} slices | ${closedTasks}/${allTasks.length} tasks | ${totalTime > 0 ? formatDuration(totalTime) : "0s"} elapsed`,
	);

	return lines.join("\n").trimEnd();
}

function formatDuration(ms: number): string {
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return `${min}m${rem > 0 ? `${rem}s` : ""}`;
}
