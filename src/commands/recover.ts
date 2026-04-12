import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { getLastCheckpoint } from "../common/checkpoint.js";
import { getSlice, updateSliceStatus } from "../common/db.js";
import { gitEnv } from "../common/git.js";
import type { RecoveryClassification } from "../common/recovery.js";
import { releaseLock } from "../common/session-lock.js";
import { type SliceStatus, sliceLabel } from "../common/types.js";
import { getWorktreePath, worktreeExists } from "../common/worktree.js";

export interface RecoverOptions {
	action: RecoveryClassification | "dismiss";
	sliceId: string;
	milestoneNumber: number;
}

export function executeRecovery(
	db: Database.Database,
	root: string,
	opts: RecoverOptions,
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
				message: `Lock cleared. Re-run the current phase with \`/tff next\` or \`/tff ${statusToPhase(slice.status)}\`.`,
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
				message: `Rolled back to ${last}. Re-run the phase with \`/tff next\`.${undoHint}`,
			};
		}

		case "skip": {
			const nextStatus = skipForwardStatus(slice.status);
			if (nextStatus) {
				updateSliceStatus(db, sliceId, nextStatus);
			}
			releaseLock(root);
			return {
				success: true,
				message: `Fast-forwarded ${sLabel} from ${slice.status} to ${nextStatus ?? "unchanged"}. Run \`/tff next\` to continue.`,
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
		reviewing: "next",
		shipping: "ship",
	};
	return map[status] ?? "next";
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
