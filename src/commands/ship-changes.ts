import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";

export interface ShipChangesResult {
	success: boolean;
	message: string;
	feedback: string;
	milestoneNumber: number;
	sliceId: string;
	sliceLabel: string;
}

/**
 * PR review requested changes. We stash the reviewer feedback as
 * `REVIEW_FEEDBACK.md` under the slice's artifact dir and leave the slice in
 * `shipping` status. The user decides how to fix:
 *   - Small fix → edit worktree, push, then `/tff ship-merged` once merged.
 *   - Large fix → `/tff execute <slice>` to re-enter TDD (which will pick
 *     up REVIEW_FEEDBACK.md and reset tasks itself).
 *
 * Pairs with `/tff ship-merged` for the manual-review loop — neither command
 * polls GitHub; the user's answer is the source of truth.
 */
export function handleShipChanges(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceIdOrLabel: string,
	feedback: string,
): { success: false; message: string } | ShipChangesResult {
	const slice = getSlice(db, sliceIdOrLabel);
	if (!slice) {
		return { success: false, message: `Slice not found: ${sliceIdOrLabel}` };
	}
	if (slice.status === "closed") {
		return {
			success: false,
			message: `Slice ${sliceIdOrLabel} is already closed — cannot accept change requests.`,
		};
	}
	if (feedback.trim().length === 0) {
		return {
			success: false,
			message: "No feedback provided. Usage: /tff ship-changes <slice> <reviewer feedback text>",
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			success: false,
			message: `Milestone not found for slice ${sliceIdOrLabel}.`,
		};
	}

	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);
	const startTime = Date.now();

	writeArtifact(
		root,
		`milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`,
		`# Review Feedback\n\n${feedback.trim()}\n`,
	);

	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_failed",
		phase: "ship",
		durationMs: Date.now() - startTime,
		error: "PR review requested changes",
	});

	return {
		success: true,
		message: `Review feedback recorded for ${sLabel}.`,
		feedback,
		milestoneNumber: milestone.number,
		sliceId: slice.id,
		sliceLabel: sLabel,
	};
}

export async function runShipChanges(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root } = project;
	const label = args[0] ?? "";
	const slice = label ? resolveSlice(database, label) : findActiveSlice(database);
	if (!slice) {
		const msg = label ? `Slice not found: ${label}` : "No active slice found.";
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, "error");
		return;
	}
	const feedback = args.slice(1).join(" ").trim();
	const result = handleShipChanges(pi, database, root, slice.id, feedback);
	if (!result.success) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(result.message, "error");
		else pi.sendUserMessage(result.message);
		return;
	}
	const sLabel = result.sliceLabel;
	pi.sendUserMessage(
		[
			`Review feedback recorded for ${sLabel}.`,
			"",
			"Reviewer said:",
			`> ${result.feedback}`,
			"",
			`For small fixes: edit the worktree, push to the slice branch, then run \`/tff ship-merged ${sLabel}\` once merged.`,
			"",
			`For larger fixes: run \`/tff execute ${sLabel}\` to re-enter the TDD loop (tasks will be reset automatically).`,
		].join("\n"),
	);
}
