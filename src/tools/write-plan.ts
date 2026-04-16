import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { compressIfEnabled } from "../common/compress.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import {
	clearSliceTasks,
	getMilestone,
	getSlice,
	insertDependency,
	insertTask,
	updateTaskWave,
} from "../common/db.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { requestReview } from "../common/plannotator-review.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { computeWaves } from "../common/waves.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";

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
	settings: Settings = DEFAULT_SETTINGS,
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
	writeArtifact(root, path, compressIfEnabled(content, "artifacts", settings));

	clearSliceTasks(db, sliceId);

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

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_plan",
			label: "TFF Write Plan",
			description:
				"Write the PLAN.md artifact for a slice and register tasks with dependency graph. THIS IS THE ONLY TOOL THAT MARKS THE PLAN PHASE COMPLETE — phase_complete fires here. After this tool returns successfully, STOP. Do not call any plannotator_* tools — TFF handles plan review automatically via event bus. If this tool returns an error with feedback, the user rejected the plan; revise and call this tool again.",
			promptSnippet:
				"The plan phase is not complete until tff_write_plan returns successfully. Writing PLAN.md via Write/Edit will NOT persist tasks — the database needs structured task entries via this tool.",
			promptGuidelines: [
				"Call this tool to persist PLAN.md AND structured tasks — not Write/Edit",
				"A successful call is the sole phase_complete signal for plan",
				"tasks array must not be empty — if you cannot decompose, ask the user via tff_ask_user",
				"Plannotator review opens automatically after writing",
				"IMPORTANT: Do not call plannotator tools after this tool returns. Review is automatic.",
				"If tool returns error with feedback, user rejected plan; revise and retry.",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the plan",
				}),
				tasks: Type.Array(
					Type.Object({
						title: Type.String({ description: "Short task title" }),
						description: Type.String({ description: "What this task involves" }),
						dependsOn: Type.Optional(
							Type.Array(Type.Number(), {
								description:
									"1-based indices of tasks this depends on (e.g. [1, 3] means depends on task 1 and task 3)",
							}),
						),
						files: Type.Optional(
							Type.Array(Type.String(), {
								description: "Files this task will touch",
							}),
						),
					}),
					{ description: "List of tasks that make up the implementation plan" },
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const root = ctx.projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const writeResult = handleWritePlan(
						database,
						root,
						slice.id,
						params.content,
						params.tasks,
						ctx.settings ?? DEFAULT_SETTINGS,
					);
					if (!writeResult.isError) {
						const review = await requestReview(
							pi,
							String(writeResult.details.path),
							params.content,
							"plan",
						);
						if (!review.approved) {
							return {
								content: [
									{
										type: "text",
										text: `PLAN.md review rejected in plannotator.\nFeedback: ${review.feedback ?? "(none)"}\nAddress the feedback and call tff_write_plan again with an updated tasks array.`,
									},
								],
								details: {
									...writeResult.details,
									reviewRejected: true,
									feedback: review.feedback,
								},
								isError: true,
							};
						}
						const hint = emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"plan",
							verifyPhaseArtifacts,
						);
						return {
							...writeResult,
							content: [
								{
									type: "text" as const,
									text: `${writeResult.content[0]?.text ?? ""} Approved by plannotator — the gate has cleared.${hint ? ` Plan phase complete. Stop here; the user will advance.\n\n${hint}` : ""}`,
								},
							],
						};
					}
					return writeResult;
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);
}
