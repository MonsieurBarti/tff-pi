import { readArtifact } from "../common/artifacts.js";
import { getTasksByWave, updateSliceStatus, updateTaskStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sanitizeForPrompt, sliceLabel, taskLabel } from "../common/types.js";
import { createWorktree } from "../common/worktree.js";
import { loadPhaseResources } from "../orchestrator.js";

const MAX_TASK_RETRIES = 2;

export const executePhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "executing");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const startTime = Date.now();
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "execute",
		});

		const milestoneBranch = `milestone/${mLabel}`;
		const wtPath = createWorktree(root, sLabel, milestoneBranch);

		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite comments and docs in compressed R1-R10 notation. Preserve: code blocks, file paths, AC checkboxes."
			: "";

		const retryContext = ctx.feedback ? `\n\n## Previous Failure Context\n${ctx.feedback}` : "";

		const { agentPrompt, protocol } = loadPhaseResources("execute");

		const waveMap = getTasksByWave(db, slice.id);
		if (waveMap.size === 0) {
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_complete",
				phase: "execute",
				durationMs: Date.now() - startTime,
			});
			return { success: true, retry: false };
		}

		const waveNumbers = [...waveMap.keys()].sort((a, b) => a - b);
		const totalWaves = waveNumbers.length;
		let previousWaveOutputs = "";

		for (const waveNum of waveNumbers) {
			const tasks = waveMap.get(waveNum);
			if (!tasks || tasks.length === 0) continue;

			for (const task of tasks) {
				const label = `executor:${sLabel}:${taskLabel(task.number)}`;
				updateTaskStatus(db, task.id, "in_progress", label);
			}

			pi.events.emit("tff:wave", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "wave_started",
				wave: waveNum,
				totalWaves,
				taskCount: tasks.length,
			});
			const waveStart = Date.now();

			const results = await Promise.allSettled(
				tasks.map(async (task) => {
					const tLabel = taskLabel(task.number);
					pi.events.emit("tff:task", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "task_dispatched",
						taskId: task.id,
						taskTitle: task.title,
						wave: waveNum,
					});
					const prompt = {
						systemPrompt: [
							agentPrompt,
							protocol,
							`\nSlice: ${sLabel}, Task: ${tLabel}`,
							compressHint,
						]
							.filter(Boolean)
							.join("\n\n"),
						userPrompt: [
							`## Task: ${tLabel} — ${sanitizeForPrompt(task.title)}`,
							"",
							"## SPEC.md (Acceptance Criteria)",
							specMd,
							"",
							"## PLAN.md",
							planMd,
							previousWaveOutputs ? `\n## Previous Wave Outputs\n${previousWaveOutputs}` : "",
							retryContext,
						].join("\n"),
						tools: [],
						label: `executor:${sLabel}:${tLabel}`,
					};
					return {
						task,
						result: await dispatchSubAgent(pi, "executor", prompt, wtPath, ctx.onSubAgentActivity),
					};
				}),
			);

			const failedTasks: Array<{ task: (typeof tasks)[number]; output: string }> = [];
			const waveOutputs: string[] = [];

			for (let i = 0; i < results.length; i++) {
				const settled = results[i];
				if (!settled) continue;
				if (settled.status === "rejected") {
					const task = tasks[i];
					if (task) {
						failedTasks.push({ task, output: (settled.reason as Error).message });
					}
					continue;
				}
				const { task, result } = settled.value;
				if (result.success) {
					updateTaskStatus(db, task.id, "closed");
					waveOutputs.push(`${taskLabel(task.number)}: ${result.output}`);
					pi.events.emit("tff:task", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "task_completed",
						taskId: task.id,
						taskTitle: task.title,
						wave: waveNum,
					});
				} else {
					failedTasks.push({ task, output: result.output });
					pi.events.emit("tff:task", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "task_failed",
						taskId: task.id,
						taskTitle: task.title,
						wave: waveNum,
						error: result.output,
					});
				}
			}

			for (const failed of [...failedTasks]) {
				let retried = false;
				for (let attempt = 0; attempt < MAX_TASK_RETRIES; attempt++) {
					const tLabel = taskLabel(failed.task.number);
					pi.events.emit("tff:task", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "task_retried",
						taskId: failed.task.id,
						taskTitle: failed.task.title,
						wave: waveNum,
						attempt: attempt + 1,
					});
					const retryPrompt = {
						systemPrompt: [
							agentPrompt,
							protocol,
							`\nSlice: ${sLabel}, Task: ${tLabel}\n\nPrevious attempt failed: ${failed.output}`,
							compressHint,
						]
							.filter(Boolean)
							.join("\n\n"),
						userPrompt: [
							`## Task: ${tLabel} — ${failed.task.title}`,
							"",
							"## SPEC.md (Acceptance Criteria)",
							specMd,
							"",
							"## PLAN.md",
							planMd,
						].join("\n"),
						tools: [],
						label: `executor:${sLabel}:${tLabel}:retry${attempt + 1}`,
					};
					const retryResult = await dispatchSubAgent(
						pi,
						"executor",
						retryPrompt,
						wtPath,
						ctx.onSubAgentActivity,
					);
					if (retryResult.success) {
						updateTaskStatus(db, failed.task.id, "closed");
						waveOutputs.push(`${tLabel}: ${retryResult.output}`);
						retried = true;
						break;
					}
					pi.events.emit("tff:task", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "task_failed",
						taskId: failed.task.id,
						taskTitle: failed.task.title,
						wave: waveNum,
						error: retryResult.output,
					});
				}
				if (!retried) {
					pi.events.emit("tff:wave", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "wave_completed",
						wave: waveNum,
						totalWaves,
						taskCount: tasks.length,
						durationMs: Date.now() - waveStart,
					});
					const errorMsg = `Task ${taskLabel(failed.task.number)} failed after ${MAX_TASK_RETRIES} retries: ${failed.output}`;
					pi.events.emit("tff:phase", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "phase_failed",
						phase: "execute",
						durationMs: Date.now() - startTime,
						error: errorMsg,
					});
					return {
						success: false,
						retry: false,
						error: errorMsg,
					};
				}
			}

			pi.events.emit("tff:wave", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "wave_completed",
				wave: waveNum,
				totalWaves,
				taskCount: tasks.length,
				durationMs: Date.now() - waveStart,
			});

			previousWaveOutputs += waveOutputs.join("\n");
		}

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_complete",
			phase: "execute",
			durationMs: Date.now() - startTime,
		});
		return { success: true, retry: false };
	},
};
