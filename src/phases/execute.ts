import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readArtifact } from "../common/artifacts.js";
import { createCheckpoint } from "../common/checkpoint.js";
import { getTasksByWave, resetTasksToOpen } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import {
	type Task,
	milestoneLabel,
	sanitizeForPrompt,
	sliceLabel,
	taskLabel,
} from "../common/types.js";
import { createWorktree } from "../common/worktree.js";
import {
	enrichContextWithFff,
	loadPhaseResources,
	predecessorPhase,
	verifyPhaseArtifacts,
} from "../orchestrator.js";

export const executePhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;

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
		createCheckpoint(wtPath, sLabel, "pre-execute");

		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite comments and docs in compressed R1-R10 notation. Preserve: code blocks, file paths, AC checkboxes."
			: "";

		// Pick up stashed review feedback from ship-changes / ship re-entry.
		// Fold it into ctx.feedback, reset tasks, then delete the artifact so
		// subsequent runs don't re-apply it.
		const feedbackRel = `milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`;
		const feedbackPath = join(root, ".tff", feedbackRel);
		let combinedFeedback = ctx.feedback ?? "";
		if (existsSync(feedbackPath)) {
			const stashed = readArtifact(root, feedbackRel) ?? "";
			combinedFeedback = combinedFeedback ? `${combinedFeedback}\n\n${stashed}` : stashed;
			resetTasksToOpen(db, slice.id);
			try {
				unlinkSync(feedbackPath);
			} catch {
				// Non-fatal: artifact will be overwritten on next ship-changes.
			}
		}
		const retryContext = combinedFeedback
			? `\n\n## Previous Failure Context\n${combinedFeedback}`
			: "";

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

		// Best-effort: enrich with related files discovered via fff bridge.
		const extrasContext: Record<string, string> = {};
		if (ctx.fffBridge) {
			const allTasks: Task[] = [];
			for (const waveTasks of waveMap.values()) {
				allTasks.push(...waveTasks);
			}
			await enrichContextWithFff(extrasContext, allTasks, ctx.fffBridge);
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

		const messageParts = [
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
			"",
			"## Wave progression",
			"Process every wave above in order within this same session. After all",
			"tasks in a wave are committed, call `tff_checkpoint` with `wave-{N}`",
			"and move straight to the next wave — do NOT stop or ask the user to",
			"resume between waves. The phase is only done when the final wave's",
			"tasks are all committed.",
		];

		if (extrasContext.RELATED_FILES) {
			messageParts.push("", "## Related Files", "", extrasContext.RELATED_FILES);
		}

		messageParts.push(compressHint, retryContext);
		const message = messageParts.join("\n");

		return { success: true, retry: false, message };
	},
};
