import { readArtifact } from "../common/artifacts.js";
import { getTasksByWave, updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sanitizeForPrompt, sliceLabel, taskLabel } from "../common/types.js";
import { createWorktree } from "../common/worktree.js";
import { loadPhaseResources, predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

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

		closePredecessorIfReady(pi, db, root, slice, "execute", predecessorPhase, verifyPhaseArtifacts);

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
			const error =
				"No tasks persisted in DB for this slice. The plan phase did not call tff_write_plan successfully. Re-run plan.";
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "execute",
				error,
			});
			return { success: false, retry: false };
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

		const worktreeGate = [
			"<HARD-GATE>",
			"All file writes and git operations MUST target the worktree path below.",
			"Do NOT write to the project root. The worktree is a separate git branch.",
			"",
			`  WORKTREE: ${wtPath}`,
			"",
			"Required discipline:",
			`  - Before any bash command: \`cd ${wtPath}\` (or pass cwd to the tool).`,
			`  - For Write/Edit: use ABSOLUTE paths under ${wtPath}/...`,
			"  - `git commit` must run inside the worktree so commits land on the slice branch.",
			"  - Never modify files outside this directory (including the TFF parent repo).",
			"",
			"If you write to the wrong directory, the verify phase will see an empty",
			"diff and refuse to advance — you will have to redo everything.",
			"</HARD-GATE>",
		].join("\n");

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			worktreeGate,
			"",
			`## Slice: ${sLabel} — "${slice.title}"`,
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
