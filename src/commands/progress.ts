import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import { getMilestones, getPhaseRuns, getProject, getSlices, getTasks } from "../common/db.js";
import { formatDuration } from "../common/format.js";
import { PIPELINE_PHASE_ORDER, milestoneLabel, sliceLabel } from "../common/types.js";

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
				// Numerator: distinct phases with at least one completed run (retries
				// of the same phase don't inflate the count).
				const completedPhaseSet = new Set(
					runs.filter((r) => r.status === "completed").map((r) => r.phase),
				);
				const completedPhases = completedPhaseSet.size;
				// Denominator: S-tier skips research (6 phases); all others use 7.
				// Null tier (not yet set) defaults to the full 7-phase pipeline.
				const expectedPhases =
					slice.tier === "S" ? PIPELINE_PHASE_ORDER.length - 1 : PIPELINE_PHASE_ORDER.length;
				const phaseStr = runs.length > 0 ? `${completedPhases}/${expectedPhases}` : "—";
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

export async function runProgress(
	pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	_args: string[],
): Promise<void> {
	const result = handleProgress(getDb(ctx));
	pi.sendUserMessage(result);
}
