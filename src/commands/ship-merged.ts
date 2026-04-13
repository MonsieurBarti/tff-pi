import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, findSliceByLabel, getDb } from "../common/context.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";
import { finalizeMergedSlice, suggestNextAction } from "../phases/ship.js";

export interface ShipMergedResult {
	success: boolean;
	message: string;
}

/**
 * User-attested PR merge: runs the same cleanup as the MERGED re-entry branch
 * of `shipPhase` without consulting GitHub. This is the standard flow for
 * manual-review projects — once the user confirms the PR was merged, we reap
 * the worktree, delete slice branches, pull the milestone, and close the slice.
 *
 * We deliberately do NOT verify with `gh pr view` here: users want this to
 * work even when gh auth is scoped to their browser, and the attest-don't-
 * verify pattern matches TFF-CC's `AskUserQuestion` gate.
 */
export function handleShipMerged(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceIdOrLabel: string,
): ShipMergedResult {
	const slice = getSlice(db, sliceIdOrLabel);
	if (!slice) {
		return { success: false, message: `Slice not found: ${sliceIdOrLabel}` };
	}
	if (slice.status === "closed") {
		return {
			success: false,
			message: `Slice ${sliceIdOrLabel} is already closed.`,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			success: false,
			message: `Milestone not found for slice ${sliceIdOrLabel}.`,
		};
	}

	const sLabel = sliceLabel(milestone.number, slice.number);
	const startTime = Date.now();

	finalizeMergedSlice(db, root, slice, milestone.number);

	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_complete",
		phase: "ship",
		durationMs: Date.now() - startTime,
	});

	const next = suggestNextAction(db, slice.milestoneId);
	return {
		success: true,
		message: `${sLabel} closed. ${next}`,
	};
}

export async function runShipMerged(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const database = getDb(ctx);
	const root = ctx.projectRoot;
	if (!root) return;
	const label = args[0] ?? "";
	const slice = label
		? (findSliceByLabel(database, label) ?? getSlice(database, label))
		: findActiveSlice(database);
	if (!slice) {
		const msg = label ? `Slice not found: ${label}` : "No active slice found.";
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, "error");
		return;
	}
	const result = handleShipMerged(pi, database, root, slice.id);
	if (result.success) {
		pi.sendUserMessage(`PR merged. ${result.message}`);
		if (uiCtx?.hasUI) uiCtx.ui.notify("Slice closed.", "info");
	} else {
		if (uiCtx?.hasUI) uiCtx.ui.notify(result.message, "error");
	}
}
