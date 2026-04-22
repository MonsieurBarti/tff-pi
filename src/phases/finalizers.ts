import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type Database from "better-sqlite3";
import { deleteArtifact, readArtifact, tffPath, writeArtifact } from "../common/artifacts.js";
import { milestoneBranchName } from "../common/branch-naming.js";
import { createCheckpoint } from "../common/checkpoint.js";
import { commitCommand } from "../common/commit.js";
import {
	getLatestPhaseRun,
	getMilestone,
	getSlice,
	getTasksByWave,
	resetTasksToOpen,
	updateTaskStatus,
} from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { auditVerificationAgainstCapture, formatAuditReport } from "../common/evidence-auditor.js";
import { getTrackedDirtyEntries } from "../common/git.js";
import { computeNextHint } from "../common/phase-completion.js";
import {
	type FinalizeInput,
	type FinalizeOutcome,
	prepareDispatch,
	registerPhaseFinalizer,
} from "../common/subagent-dispatcher.js";
import {
	type Task,
	milestoneLabel,
	sanitizeForPrompt,
	sliceLabel,
	taskLabel,
} from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";

const VERDICT_RE = /^VERDICT:\s*(approved|denied)\s*$/gm;

// Persisted sidecar for execute's fff-bridge context. Written by
// executePhase.prepare() once per phase entry; read here to keep waves 2+
// dispatches as rich as wave 1. Deleted on execute completion.
export const EXECUTE_RELATED_FILES_FILE = "execute-related-files.txt";

function executeRelatedFilesPath(root: string): string {
	return tffPath(root, EXECUTE_RELATED_FILES_FILE);
}

export function writeExecuteRelatedFiles(root: string, content: string): void {
	writeArtifact(root, EXECUTE_RELATED_FILES_FILE, content);
}

function readExecuteRelatedFiles(root: string): string | null {
	if (!existsSync(executeRelatedFilesPath(root))) return null;
	return readFileSync(executeRelatedFilesPath(root), "utf-8");
}

function removeExecuteRelatedFiles(root: string): void {
	try {
		unlinkSync(executeRelatedFilesPath(root));
	} catch {
		// best-effort cleanup
	}
}

// ---------------------------------------------------------------------------
// Review finalizer
// ---------------------------------------------------------------------------

async function reviewFinalizer({
	pi,
	db,
	root,
	config,
	result,
}: FinalizeInput): Promise<FinalizeOutcome> {
	if (!config.sliceId) return { continue: false };
	const slice = getSlice(db, config.sliceId);
	if (!slice) return { continue: false };
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return { continue: false };
	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);
	const wtPath = getWorktreePath(root, sLabel);
	const sliceRel = `milestones/${mLabel}/slices/${sLabel}`;
	const reviewRel = `${sliceRel}/REVIEW.md`;

	const r = result.results[0];

	if (!r || r.status === "BLOCKED" || r.status === "NEEDS_CONTEXT") {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: r?.evidence ?? "BLOCKED",
		});
		return { continue: false };
	}

	const dirty = getTrackedDirtyEntries(wtPath);
	if (dirty && dirty.length > 0) {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: `reviewer modified tracked files: ${dirty.slice(0, 3).join("; ")}`,
		});
		return { continue: false };
	}

	const reviewSrc = join(wtPath, ".pi", ".tff", "artifacts", "REVIEW.md");

	if (!existsSync(reviewSrc)) {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: "missing REVIEW.md",
		});
		return { continue: false };
	}

	if (lstatSync(reviewSrc).isSymbolicLink()) {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: `symlink rejected: ${basename(reviewSrc)}`,
		});
		return { continue: false };
	}

	const reviewMd = readFileSync(reviewSrc, "utf-8");
	const verdictMatches = [...reviewMd.matchAll(VERDICT_RE)];
	const verdictMatch = verdictMatches.at(-1);
	if (!verdictMatch) {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: "missing or malformed VERDICT",
		});
		return { continue: false };
	}
	const verdict = verdictMatch[1] as "approved" | "denied";

	if (verdict === "denied") {
		writeArtifact(root, reviewRel, reviewMd);
		commitCommand(db, root, "review-rejected", { sliceId: slice.id });
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: "Review verdict: denied",
		});
		return { continue: false };
	}

	const latestRun = getLatestPhaseRun(db, slice.id, "review");
	const alreadyCompleted = latestRun?.status === "completed";

	writeArtifact(root, reviewRel, reviewMd);
	if (!alreadyCompleted) {
		commitCommand(db, root, "write-review", { sliceId: slice.id });
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_complete",
			phase: "review",
		});
	}

	// Use the pre-commit slice (status="reviewing"). commitCommand advances the
	// slice to "shipping" via the reconciler; reloading after the commit would
	// make determineNextPhase skip past `ship` and fall through to the next
	// open slice or complete-milestone.
	const hint = computeNextHint(db, slice, milestone.number);
	if (hint) {
		// Finalizer runs in the tool_result hook while the dispatcher is still
		// streaming (the subagent call just returned). sendUserMessage must
		// specify deliverAs or the agent raises "already processing". followUp
		// queues the hint to fire after the current turn ends so the user sees
		// it cleanly after DISPATCH_COMPLETE.
		pi.sendUserMessage(`Review complete. Stop here; the user will advance.\n\n${hint}`, {
			deliverAs: "followUp",
		});
	}
	return { continue: false };
}

// ---------------------------------------------------------------------------
// Verify finalizer
// ---------------------------------------------------------------------------

async function verifyFinalizer({
	pi,
	db,
	root,
	config,
	result,
	calls,
}: FinalizeInput): Promise<FinalizeOutcome> {
	if (!config.sliceId) return { continue: false };
	const slice = getSlice(db, config.sliceId);
	if (!slice) return { continue: false };
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return { continue: false };
	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);
	const wtPath = getWorktreePath(root, sLabel);
	const sliceRel = `milestones/${mLabel}/slices/${sLabel}`;

	const r = result.results[0];
	if (!r || r.status === "BLOCKED" || r.status === "NEEDS_CONTEXT") {
		// Mirror the pre-refactor behavior: reset tasks so the user can re-enter execute.
		resetTasksToOpen(db, slice.id);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "verify",
			error: r?.evidence ?? "BLOCKED",
		});
		return { continue: false };
	}

	const dirty = getTrackedDirtyEntries(wtPath);
	if (dirty && dirty.length > 0) {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "verify",
			error: `reviewer modified tracked files: ${dirty.slice(0, 3).join("; ")}`,
		});
		return { continue: false };
	}

	const artifactsDir = join(wtPath, ".pi", ".tff", "artifacts");
	const vSrc = join(artifactsDir, "VERIFICATION.md");
	const prSrc = join(artifactsDir, "PR.md");
	if (!existsSync(vSrc) || !existsSync(prSrc)) {
		const missing = !existsSync(vSrc) ? "VERIFICATION.md" : "PR.md";
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "verify",
			error: `missing ${missing}`,
		});
		return { continue: false };
	}

	for (const p of [vSrc, prSrc]) {
		if (lstatSync(p).isSymbolicLink()) {
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestone.number),
				type: "phase_failed",
				phase: "verify",
				error: `symlink rejected: ${basename(p)}`,
			});
			return { continue: false };
		}
	}

	const vMd = readFileSync(vSrc, "utf-8");
	const prMd = readFileSync(prSrc, "utf-8");
	const auditReport = auditVerificationAgainstCapture(vMd, calls);

	const vRel = `${sliceRel}/VERIFICATION.md`;
	const auditRel = `${sliceRel}/VERIFICATION-AUDIT.md`;
	const blockedRel = `${sliceRel}/.audit-blocked`;
	const prRel = `${sliceRel}/PR.md`;

	if (auditReport.hasMismatches) {
		writeArtifact(root, vRel, vMd);
		writeArtifact(root, auditRel, formatAuditReport(auditReport));
		writeArtifact(root, blockedRel, "Audit found mismatches. See VERIFICATION-AUDIT.md.\n");
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "verify",
			error: `audit mismatch: ${auditReport.summary.mismatch}`,
		});
		return { continue: false };
	}

	deleteArtifact(root, blockedRel);
	deleteArtifact(root, auditRel);

	const latestRun = getLatestPhaseRun(db, slice.id, "verify");
	const alreadyCompleted = latestRun?.status === "completed";

	if (!alreadyCompleted) {
		// PR.md first: write-verification flips phase_run.status to completed and
		// reconcileSliceStatus promotes the slice out of verifying, which would
		// then fail write-pr's "verifying + verify started" precondition.
		writeArtifact(root, prRel, prMd);
		commitCommand(db, root, "write-pr", { sliceId: slice.id });
		writeArtifact(root, vRel, vMd);
		commitCommand(db, root, "write-verification", { sliceId: slice.id });
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_complete",
			phase: "verify",
		});
	} else {
		writeArtifact(root, prRel, prMd);
		writeArtifact(root, vRel, vMd);
	}

	// Pre-commit slice (status="verifying"). Post-commit status is "reviewing"
	// which would make determineNextPhase return "review" for verify — i.e.,
	// the same phase we're trying to say comes next. Keep the stale slice.
	const hint = computeNextHint(db, slice, milestone.number);
	if (hint) {
		pi.sendUserMessage(`Verify complete. Stop here; the user will advance.\n\n${hint}`, {
			deliverAs: "followUp",
		});
	}
	return { continue: false };
}

// ---------------------------------------------------------------------------
// Execute finalizer — multi-wave, stateless
// ---------------------------------------------------------------------------

interface OpenWave {
	wave: number;
	tasks: Task[];
}

function computeOpenWaves(db: Database.Database, sliceId: string): OpenWave[] {
	const waveMap = getTasksByWave(db, sliceId);
	const out: OpenWave[] = [];
	for (const n of [...waveMap.keys()].sort((a, b) => a - b)) {
		const openTasks = (waveMap.get(n) ?? []).filter((t) => t.status !== "closed");
		if (openTasks.length > 0) out.push({ wave: n, tasks: openTasks });
	}
	return out;
}

function dispatchedWaveNumber(
	db: Database.Database,
	config: FinalizeInput["config"],
): number | null {
	// All tasks within a single dispatched wave share the same `wave` column.
	// Pull it from the first taskId we dispatched.
	const firstTaskId = config.tasks.find((t) => t.taskId)?.taskId;
	if (!firstTaskId) return null;
	const row = db.prepare("SELECT wave FROM task WHERE id = ?").get(firstTaskId) as
		| { wave?: number | null }
		| undefined;
	return row?.wave ?? null;
}

function buildExecutorTaskBody(
	task: Task,
	sLabel: string,
	wtPath: string,
	totalWaves: number,
	testInstruction: string,
): string {
	const filesBlock = "None declared; infer from scope";
	return [
		`Task: ${taskLabel(task.number)} — "${sanitizeForPrompt(task.title)}"`,
		`Wave: ${task.wave ?? 0} of ${totalWaves}`,
		`Task ID: ${task.id}`,
		"",
		`Working directory: ${wtPath}`,
		`Slice: ${sLabel}`,
		"",
		"## Scope",
		sanitizeForPrompt(task.title),
		"",
		"## Files (from PLAN.md)",
		filesBlock,
		"",
		"## Rules",
		`1. Work exclusively under ${wtPath}. All writes, all git commands.`,
		"2. TDD per behavior: failing test → minimal implementation → commit.",
		`   Commit message: \`feat(${sLabel}): ${taskLabel(task.number)} — <short desc>\`.`,
		"3. Only modify files listed in `## Files` (or strictly within the scope if the",
		"   list is empty). Other executors in this wave are working on disjoint files",
		"   in parallel.",
		"4. If you hit `fatal: Unable to create '.../index.lock'`, retry the git",
		"   command once. If it still fails, surface BLOCKED.",
		"5. Do NOT call `tff_checkpoint` or `tff_execute_done` — they no longer exist.",
		"   The wave checkpoint and phase completion are stamped automatically after",
		"   every subagent in this wave returns.",
		`6. Run scoped tests for your changes before returning: ${testInstruction}`,
		"7. End your final response with:",
		"   STATUS: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>",
		"   EVIDENCE: <one-line summary>",
	].join("\n");
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

async function executeFinalizer({
	pi,
	db,
	root,
	settings,
	config,
	result,
}: FinalizeInput): Promise<FinalizeOutcome> {
	if (!config.sliceId) return { continue: false };
	const slice = getSlice(db, config.sliceId);
	if (!slice) return { continue: false };
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return { continue: false };
	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);
	const wtPath = getWorktreePath(root, sLabel);

	const done = result.results.filter(
		(x) => x.status === "DONE" || x.status === "DONE_WITH_CONCERNS",
	);
	const blocked = result.results.filter(
		(x) => x.status === "BLOCKED" || x.status === "NEEDS_CONTEXT",
	);

	for (const r of done) {
		if (r.taskId) updateTaskStatus(db, r.taskId, "closed");
	}

	const waveNum = dispatchedWaveNumber(db, config) ?? 0;

	if (blocked.length > 0) {
		createCheckpoint(wtPath, sLabel, `wave-${waveNum}-partial`);
		const summary = blocked.map((b) => `${b.taskId ?? "?"}: ${b.evidence}`).join("; ");
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestone.number),
			type: "phase_failed",
			phase: "execute",
			error: `BLOCKED: ${summary}`,
		});
		return { continue: false };
	}

	createCheckpoint(wtPath, sLabel, `wave-${waveNum}`);

	const openWaves = computeOpenWaves(db, slice.id);
	if (openWaves.length === 0) {
		const latestRun = getLatestPhaseRun(db, slice.id, "execute");
		const alreadyCompleted = latestRun?.status === "completed";
		if (!alreadyCompleted) {
			commitCommand(db, root, "execute-done", { sliceId: slice.id });
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestone.number),
				type: "phase_complete",
				phase: "execute",
			});
		}
		removeExecuteRelatedFiles(root);
		// Pre-commit slice (status="executing"). Post-commit status is "verifying"
		// which would tell the user to run `/tff review` — skipping verify
		// entirely. Use the stale status so the hint points at `/tff verify`.
		const hint = computeNextHint(db, slice, milestone.number);
		if (hint) {
			pi.sendUserMessage(`Execute complete. Stop here; the user will advance.\n\n${hint}`, {
				deliverAs: "followUp",
			});
		}
		return { continue: false };
	}

	// Next wave: rebuild dispatch from DB + disk (no closure state).
	const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
	const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
	const reviewFeedback =
		readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`) ?? "";
	const relatedFiles = readExecuteRelatedFiles(root) ?? "";

	let testInstruction: string;
	if (settings.test_command === "disabled") {
		testInstruction = "Test execution is disabled. Skip the test stage.";
	} else if (settings.test_command) {
		testInstruction = `Run tests with: ${settings.test_command}`;
	} else {
		testInstruction =
			"Auto-discover the test command from project files (package.json, Makefile, etc.). Run scoped tests for changed files where possible.";
	}

	const milestoneRow = getMilestone(db, slice.milestoneId);
	if (!milestoneRow) return { continue: false };
	const milestoneBranch = milestoneBranchName(milestoneRow);
	const totalWaves = openWaves.length + (waveNum > 0 ? waveNum : 0);

	const nextWave = openWaves[0];
	if (!nextWave) return { continue: false };
	prepareDispatch(root, {
		mode: "parallel",
		phase: "execute",
		sliceId: slice.id,
		tasks: nextWave.tasks.map((t) => {
			const artifacts: { label: string; content: string }[] = [
				{ label: "SPEC.md", content: specMd },
				{ label: "PLAN.md", content: planMd },
				{ label: "Worktree gate", content: buildWorktreeGate(wtPath) },
			];
			if (reviewFeedback.length > 0) {
				artifacts.push({ label: "Previous review feedback", content: reviewFeedback });
			}
			if (relatedFiles.length > 0) {
				artifacts.push({ label: "Related files", content: relatedFiles });
			}
			return {
				agent: "tff-executor",
				task: buildExecutorTaskBody(t, sLabel, wtPath, totalWaves, testInstruction),
				cwd: wtPath,
				artifacts,
				taskId: t.id,
			};
		}),
	});
	// Reference milestoneBranch to mark intent even though the dispatcher
	// doesn't embed it today (M01-S06 hard-gate already enforces worktree path).
	void milestoneBranch;
	return { continue: true };
}

// ---------------------------------------------------------------------------
// Registration — called once at extension init
// ---------------------------------------------------------------------------

export function registerPhaseFinalizers(): void {
	registerPhaseFinalizer("review", reviewFinalizer);
	registerPhaseFinalizer("verify", verifyFinalizer);
	registerPhaseFinalizer("execute", executeFinalizer);
}
