import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readArtifact } from "../common/artifacts.js";
import { milestoneBranchName } from "../common/branch-naming.js";
import { commitCommand } from "../common/commit.js";
import { getLatestPhaseRun, getMilestone, getTasksByWave, resetTasksToOpen } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import { ensurePhaseTransition } from "../common/phase-entry.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { type DispatchConfig, prepareDispatch } from "../common/subagent-dispatcher.js";
import {
	type Task,
	milestoneLabel,
	sanitizeForPrompt,
	sliceLabel,
	taskLabel,
} from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import { enrichContextWithFff, predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";
import { writeExecuteRelatedFiles } from "./finalizers.js";

export const PENDING_WORKTREE_MARKER = "pending-execute-worktree.json";

// sliceLabel identifies the worktree's filesystem path (.tff/worktrees/<label>);
// sliceId identifies the git branch (slice/<8hex>). Both travel together so the
// session_start marker handler can materialise the worktree without a DB lookup.
export interface PendingWorktreeMarker {
	sliceLabel: string;
	sliceId: string;
	milestoneBranch: string;
}

export function pendingWorktreeMarkerPath(root: string): string {
	return join(root, ".pi", ".tff", PENDING_WORKTREE_MARKER);
}

export function writePendingWorktreeMarker(root: string, marker: PendingWorktreeMarker): void {
	mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
	writeFileSync(pendingWorktreeMarkerPath(root), JSON.stringify(marker), "utf-8");
}

interface ExecutorCtxBundle {
	specMd: string;
	planMd: string;
	wtPath: string;
	sLabel: string;
	totalWaves: number;
	reviewFeedback: string;
	extrasContextByTaskId: Map<string, string>;
	testInstruction: string;
	compressHint: string;
}

function buildWorktreeGate(wtPath: string): string {
	return [
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
}

function buildExecutorTaskBody(task: Task, ctxBundle: ExecutorCtxBundle): string {
	const filesBlock = "None declared; infer from scope";
	return [
		`Task: ${taskLabel(task.number)} — "${sanitizeForPrompt(task.title)}"`,
		`Wave: ${task.wave ?? 0} of ${ctxBundle.totalWaves}`,
		`Task ID: ${task.id}`,
		"",
		`Working directory: ${ctxBundle.wtPath}`,
		`Slice: ${ctxBundle.sLabel}`,
		"",
		"## Scope",
		sanitizeForPrompt(task.title),
		"",
		"## Files (from PLAN.md)",
		filesBlock,
		"",
		"## Rules",
		`1. Work exclusively under ${ctxBundle.wtPath}. All writes, all git commands.`,
		"2. TDD per behavior: failing test → minimal implementation → commit.",
		`   Commit message: \`feat(${ctxBundle.sLabel}): ${taskLabel(task.number)} — <short desc>\`.`,
		"3. Only modify files listed in `## Files` (or strictly within the scope if the",
		"   list is empty). Other executors in this wave are working on disjoint files",
		"   in parallel.",
		"4. If you hit `fatal: Unable to create '.../index.lock'`, retry the git",
		"   command once. If it still fails, surface BLOCKED.",
		"5. Do NOT call `tff_checkpoint` or `tff_execute_done` — they no longer exist.",
		"   The wave checkpoint and phase completion are stamped automatically after",
		"   every subagent in this wave returns.",
		`6. Run scoped tests for your changes before returning: ${ctxBundle.testInstruction}`,
		"7. End your final response with:",
		"   STATUS: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>",
		"   EVIDENCE: <one-line summary>",
	].join("\n");
}

function buildExecutorDispatchConfig(task: Task, ctxBundle: ExecutorCtxBundle): DispatchConfig {
	const artifacts: { label: string; content: string }[] = [
		{ label: "SPEC.md", content: ctxBundle.specMd },
		{ label: "PLAN.md", content: ctxBundle.planMd },
		{ label: "Worktree gate", content: buildWorktreeGate(ctxBundle.wtPath) },
	];
	if (ctxBundle.reviewFeedback.length > 0) {
		artifacts.push({ label: "Previous review feedback", content: ctxBundle.reviewFeedback });
	}
	const related = ctxBundle.extrasContextByTaskId.get(task.id);
	if (related && related.length > 0) {
		artifacts.push({ label: "Related files", content: related });
	}
	return {
		agent: "tff-executor",
		task: buildExecutorTaskBody(task, ctxBundle),
		cwd: ctxBundle.wtPath,
		artifacts,
		taskId: task.id,
	};
}

export const executePhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);

		ensurePhaseTransition(db, root, slice, "execute");

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "execute",
		});

		closePredecessorIfReady(pi, db, root, slice, "execute", predecessorPhase, verifyPhaseArtifacts);

		const milestoneRow = getMilestone(db, slice.milestoneId);
		if (!milestoneRow) {
			return { success: false, retry: false, error: `Milestone not found: ${slice.milestoneId}` };
		}
		const milestoneBranch = milestoneBranchName(milestoneRow);
		const wtPath = getWorktreePath(root, sLabel);
		writePendingWorktreeMarker(root, { sliceLabel: sLabel, sliceId: slice.id, milestoneBranch });

		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite comments and docs in compressed R1-R10 notation. Preserve: code blocks, file paths, AC checkboxes."
			: "";

		// Stash REVIEW_FEEDBACK.md (from ship-changes / review re-entry) into
		// ctx.feedback, reset tasks, then unlink the artifact so subsequent runs
		// don't re-apply it. Wave partition below runs against the post-reset DB state.
		const feedbackRel = `milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`;
		const feedbackPath = join(root, ".pi", ".tff", feedbackRel);
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

		// No-tasks error: plan phase never populated DB.
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

		// Compute wave plan from still-open tasks.
		const waveNumbers = [...waveMap.keys()].sort((a, b) => a - b);
		const waves: Task[][] = [];
		for (const n of waveNumbers) {
			const openTasks = (waveMap.get(n) ?? []).filter((t) => t.status !== "closed");
			if (openTasks.length > 0) waves.push(openTasks);
		}

		// Short-circuit: all tasks already closed → commit execute-done (if not
		// already) + emit phase_complete. Do NOT register finalizer or dispatch.
		if (waves.length === 0) {
			const latestRun = getLatestPhaseRun(db, slice.id, "execute");
			if (latestRun?.status !== "completed") {
				commitCommand(db, root, "execute-done", { sliceId: slice.id });
			}
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_complete",
				phase: "execute",
			});
			return { success: true, retry: false };
		}

		// Resolve test command instruction (mirrors verify.ts logic).
		let testInstruction: string;
		if (settings.test_command === "disabled") {
			testInstruction = "Test execution is disabled. Skip the test stage.";
		} else if (settings.test_command) {
			testInstruction = `Run tests with: ${settings.test_command}`;
		} else {
			testInstruction =
				"Auto-discover the test command from project files (package.json, Makefile, etc.). Run scoped tests for changed files where possible.";
		}

		// Best-effort: enrich per-task context via fff bridge.
		const extrasContextByTaskId = new Map<string, string>();
		if (ctx.fffBridge) {
			const allOpenTasks: Task[] = waves.flat();
			const extras: Record<string, string> = {};
			await enrichContextWithFff(extras, allOpenTasks, ctx.fffBridge);
			// enrichContextWithFff returns a single RELATED_FILES blob; forward
			// the blob to every task rather than per-task (current fffBridge
			// shape does not partition by task). Partitioning is a future
			// refinement (SPEC risk note).
			if (extras.RELATED_FILES) {
				for (const t of allOpenTasks) extrasContextByTaskId.set(t.id, extras.RELATED_FILES);
			}
		}

		const ctxBundle: ExecutorCtxBundle = {
			specMd,
			planMd,
			wtPath,
			sLabel,
			totalWaves: waves.length,
			reviewFeedback: combinedFeedback,
			extrasContextByTaskId,
			testInstruction,
			compressHint,
		};

		// Persist fff-bridge related-files for waves 2+. The finalizer runs in
		// a different session and cannot access fffBridge (session-scoped); this
		// sidecar lets it dispatch subsequent waves with the same context.
		// Deleted on execute-done (see finalizers.ts).
		if (extrasContextByTaskId.size > 0) {
			const anyBlob = [...extrasContextByTaskId.values()][0] ?? "";
			if (anyBlob.length > 0) writeExecuteRelatedFiles(root, anyBlob);
		}

		// Finalizer registered once at extension init (see src/phases/finalizers.ts
		// + lifecycle.ts). Stateless: reconstructs slice/milestone/wave-plan from
		// config.sliceId + DB + disk. Closure capture cannot work — PI's
		// newSession() isolates module state across sessions.

		const firstWave = waves[0] ?? [];
		const { message } = prepareDispatch(root, {
			mode: "parallel",
			phase: "execute",
			sliceId: slice.id,
			tasks: firstWave.map((t) => buildExecutorDispatchConfig(t, ctxBundle)),
		});

		return { success: true, retry: false, message };
	},
};
