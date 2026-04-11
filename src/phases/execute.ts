import { readArtifact } from "../common/artifacts.js";
import { getTasksByWave, updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sanitizeForPrompt, sliceLabel, taskLabel } from "../common/types.js";
import { createWorktree } from "../common/worktree.js";
import { loadPhaseResources } from "../orchestrator.js";

export const executePhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "executing");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
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
				durationMs: 0,
			});
			return { success: true, retry: false };
		}

		// Build task list for the message
		const taskLines: string[] = [];
		const waveNumbers = [...waveMap.keys()].sort((a, b) => a - b);
		for (const waveNum of waveNumbers) {
			const tasks = waveMap.get(waveNum);
			if (!tasks || tasks.length === 0) continue;
			taskLines.push(`### Wave ${waveNum}`);
			for (const task of tasks) {
				taskLines.push(`- ${taskLabel(task.number)}: ${sanitizeForPrompt(task.title)}`);
			}
			taskLines.push("");
		}

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel} — "${slice.title}"`,
			`Working directory: ${wtPath}`,
			"",
			"## SPEC.md (Acceptance Criteria)",
			specMd,
			"",
			"## PLAN.md",
			planMd,
			"",
			"## Tasks",
			taskLines.join("\n"),
			compressHint,
			retryContext,
		].join("\n");

		pi.sendUserMessage(message);
		return { success: true, retry: false };
	},
};
