import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { getLastCheckpoint } from "../common/checkpoint.js";
import { type TffContext, requireProject } from "../common/context.js";
import { getMilestone, getSlice } from "../common/db.js";
import { overrideSliceStatus, reconcileSliceStatus } from "../common/derived-state.js";
import { makeBaseEvent } from "../common/events.js";
import { gitEnv } from "../common/git.js";
import {
	type RecoveryClassification,
	diagnoseRecovery,
	scanForStuckSlices,
} from "../common/recovery.js";
import { releaseLock } from "../common/session-lock.js";
import { type SliceStatus, sliceLabel } from "../common/types.js";
import { getWorktreePath, worktreeExists } from "../common/worktree.js";

type RecoveryAction = RecoveryClassification | "dismiss";

const VALID_ACTIONS = [
	"resume",
	"rollback",
	"skip",
	"manual",
	"dismiss",
] as const satisfies readonly RecoveryAction[];

function isRecoveryAction(value: string): value is RecoveryAction {
	return (VALID_ACTIONS as readonly string[]).includes(value);
}

export interface RecoverOptions {
	action: RecoveryAction;
	sliceId: string;
	milestoneNumber: number;
}

export function executeRecovery(
	db: Database.Database,
	root: string,
	opts: RecoverOptions,
	pi: ExtensionAPI,
): { success: boolean; message: string } {
	const { action, sliceId, milestoneNumber } = opts;
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { success: false, message: "Slice not found." };
	}

	const sLabel = sliceLabel(milestoneNumber, slice.number);

	switch (action) {
		case "dismiss": {
			releaseLock(root);
			return { success: true, message: "Lock cleared. No recovery action taken." };
		}

		case "resume": {
			releaseLock(root);
			return {
				success: true,
				message: `Lock cleared. Re-run: \`/tff ${statusToPhase(slice.status)} ${sLabel}\`.`,
			};
		}

		case "rollback": {
			const wtPath = getWorktreePath(root, sLabel);
			const last = worktreeExists(root, sLabel)
				? getLastCheckpoint(wtPath, sLabel)
				: getLastCheckpoint(root, sLabel);
			if (!last) {
				releaseLock(root);
				return { success: false, message: "No checkpoint found to roll back to." };
			}

			let safetyTag: string | null = null;
			if (worktreeExists(root, sLabel)) {
				// Create safety tag at current HEAD before destructive reset
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				safetyTag = `pre-rollback/${sLabel}/${timestamp}`;
				try {
					execFileSync("git", ["tag", safetyTag], {
						cwd: wtPath,
						encoding: "utf-8",
						env: gitEnv(),
					});
				} catch (err) {
					releaseLock(root);
					return {
						success: false,
						message: `Failed to create safety tag before rollback: ${
							err instanceof Error ? err.message : String(err)
						}. Rollback aborted.`,
					};
				}

				execFileSync("git", ["reset", "--hard", last], {
					cwd: wtPath,
					encoding: "utf-8",
					env: gitEnv(),
				});
			}

			releaseLock(root);

			const undoHint = safetyTag
				? `\n\nTo undo: \`git reset --hard ${safetyTag}\` (run in the worktree)`
				: "";

			return {
				success: true,
				message: `Rolled back to ${last}. Re-run: \`/tff ${statusToPhase(slice.status)} ${sLabel}\`.${undoHint}`,
			};
		}

		case "skip": {
			const nextStatus = skipForwardStatus(slice.status);
			if (nextStatus) {
				overrideSliceStatus(db, sliceId, nextStatus, "recover-skip");
				pi.events.emit("tff:override", {
					...makeBaseEvent(sliceId, sLabel, milestoneNumber),
					type: "status_override",
					from: slice.status,
					to: nextStatus,
					reason: "recover-skip",
				});
				// Reconcile to catch conflicts introduced by the override
				reconcileSliceStatus(db, root, sliceId);
			}
			releaseLock(root);
			return {
				success: true,
				message: `Fast-forwarded ${sLabel} from ${slice.status} to ${nextStatus ?? "unchanged"}. Next: \`/tff ${nextStatus ? statusToPhase(nextStatus) : statusToPhase(slice.status)} ${sLabel}\`.`,
			};
		}

		case "manual": {
			releaseLock(root);
			return {
				success: true,
				message: "Lock cleared. Please inspect the state manually and run the appropriate command.",
			};
		}

		default:
			return { success: false, message: `Unknown recovery action: ${action}` };
	}
}

function statusToPhase(status: string): string {
	const map: Record<string, string> = {
		discussing: "discuss",
		researching: "research",
		planning: "plan",
		executing: "execute",
		verifying: "verify",
		reviewing: "ship",
		shipping: "ship",
	};
	// `status` fallback: /tff status is always safe and tells the user where
	// the slice stands after a recovery action. Never point at /tff next —
	// that command was removed in M11-S03.
	return map[status] ?? "status";
}

export async function runRecover(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root } = project;

	const rawArg = args[0];
	if (rawArg !== undefined && !isRecoveryAction(rawArg)) {
		pi.sendUserMessage(
			`Invalid recover action: \`${rawArg}\`. Valid actions: ${VALID_ACTIONS.join(", ")}.`,
		);
		return;
	}
	const explicitAction: RecoveryClassification | "dismiss" | undefined = rawArg;

	const stuck = scanForStuckSlices(database);
	if (stuck.length === 0) {
		pi.sendUserMessage("No stuck slices found. Nothing to recover.");
		releaseLock(root);
		return;
	}

	if (stuck.length > 1) {
		const labels = stuck
			.map((s) => {
				const m = getMilestone(database, s.milestoneId);
				return m ? sliceLabel(m.number, s.number) : s.id;
			})
			.join(", ");
		pi.sendUserMessage(
			`${stuck.length} stuck slices detected: ${labels}. Recovering the first one only. Re-run \`/tff recover\` to handle the rest.`,
		);
	}

	const stuckSlice = stuck[0];
	if (!stuckSlice) return;
	const milestone = getMilestone(database, stuckSlice.milestoneId);
	if (!milestone) {
		pi.sendUserMessage("Cannot find milestone for stuck slice.");
		return;
	}

	// Use explicit action if provided, otherwise fall back to diagnosed classification
	const diagnosis = diagnoseRecovery(root, database, stuckSlice.id, milestone.number);
	const action = explicitAction ?? diagnosis.classification;

	const result = executeRecovery(
		database,
		root,
		{
			action,
			sliceId: stuckSlice.id,
			milestoneNumber: milestone.number,
		},
		pi,
	);

	pi.sendUserMessage(result.message);
}

function skipForwardStatus(status: string): SliceStatus | null {
	const map: Record<string, SliceStatus> = {
		discussing: "planning",
		researching: "planning",
		planning: "executing",
		executing: "verifying",
		verifying: "reviewing",
		reviewing: "shipping",
		shipping: "closed",
	};
	return map[status] ?? null;
}
