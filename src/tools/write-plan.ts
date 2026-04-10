import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import {
	getMilestone,
	getSlice,
	insertDependency,
	insertTask,
	updateTaskWave,
} from "../common/db.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { computeWaves } from "../common/waves.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export interface TaskInput {
	title: string;
	description: string;
	dependsOn?: number[];
	files?: string[];
}

export function handleWritePlan(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
	tasks: TaskInput[],
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found for slice: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const label = sliceLabel(milestone.number, slice.number);
	const mLabel = milestoneLabel(milestone.number);
	const path = `milestones/${mLabel}/slices/${label}/PLAN.md`;
	writeArtifact(root, path, content);

	const taskIds: Map<number, string> = new Map();
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		if (!task) continue;
		const taskNumber = i + 1;
		const taskId = insertTask(db, { sliceId, number: taskNumber, title: task.title });
		taskIds.set(taskNumber, taskId);
	}

	const depRefs: { fromTaskId: string; toTaskId: string }[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		if (!task) continue;
		const taskNumber = i + 1;
		const fromId = taskIds.get(taskNumber);
		if (!fromId) continue;
		for (const depNum of task.dependsOn ?? []) {
			const toId = taskIds.get(depNum);
			if (toId) {
				insertDependency(db, { fromTaskId: fromId, toTaskId: toId });
				depRefs.push({ fromTaskId: fromId, toTaskId: toId });
			}
		}
	}

	const taskRefs = [...taskIds.entries()].map(([num, id]) => ({ id, number: num }));
	const waves = computeWaves(taskRefs, depRefs);
	for (const [taskId, wave] of waves) {
		updateTaskWave(db, taskId, wave);
	}

	const waveCount = waves.size > 0 ? Math.max(...waves.values()) : 0;
	return {
		content: [
			{
				type: "text",
				text: `PLAN.md written for ${label} with ${tasks.length} task(s) in ${waveCount} wave(s).`,
			},
		],
		details: { sliceId, path, taskCount: tasks.length, waveCount },
	};
}
