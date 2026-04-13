import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { fetchReviewFeedback } from "../common/review-feedback.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";

export interface ShipChangesResult {
	success: boolean;
	message: string;
	feedback: string;
	milestoneNumber: number;
	sliceId: string;
	sliceLabel: string;
	/** True when feedback was auto-fetched from `gh pr view`. */
	autoFetched: boolean;
}

/**
 * PR review requested changes. We stash the reviewer feedback as
 * `REVIEW_FEEDBACK.md` under the slice's artifact dir and leave the slice in
 * `shipping` status. The user decides how to fix:
 *   - Inline fix → /tff ship-fix routes to the inline-fixer agent.
 *   - Small manual edit → edit worktree, push, then `/tff ship-merged`.
 *   - Large fix → `/tff execute <slice>` to re-enter TDD.
 *
 * When `feedback` is undefined/empty, we auto-fetch the reviewer feedback
 * from the slice's PR via `gh pr view --json reviews,comments`.
 */
export async function handleShipChanges(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceIdOrLabel: string,
	feedback?: string,
): Promise<{ success: false; message: string } | ShipChangesResult> {
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

	const provided = (feedback ?? "").trim();
	let effectiveFeedback: string;
	let autoFetched = false;

	if (provided.length > 0) {
		effectiveFeedback = provided;
	} else {
		if (!slice.prUrl) {
			return {
				success: false,
				message:
					"No PR URL on slice — open the PR with `/tff ship` first, or pass the reviewer feedback text explicitly.",
			};
		}
		const fetched = fetchReviewFeedback(slice.prUrl);
		if (!fetched) {
			return {
				success: false,
				message: `PR has no review feedback yet on ${slice.prUrl}. Pass the feedback text explicitly if you want to record it.`,
			};
		}
		effectiveFeedback = fetched.markdown;
		autoFetched = true;
	}

	writeArtifact(
		root,
		`milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`,
		`# Review Feedback\n\n${effectiveFeedback}\n`,
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
		feedback: effectiveFeedback,
		milestoneNumber: milestone.number,
		sliceId: slice.id,
		sliceLabel: sLabel,
		autoFetched,
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
	const feedbackArg = args.slice(1).join(" ").trim();
	const result = await handleShipChanges(
		pi,
		database,
		root,
		slice.id,
		feedbackArg.length > 0 ? feedbackArg : undefined,
	);
	if (!result.success) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(result.message, "error");
		else pi.sendUserMessage(result.message);
		return;
	}
	const sLabel = result.sliceLabel;
	const sourceNote = result.autoFetched
		? "Auto-fetched from `gh pr view`."
		: "Recorded from the text you provided.";
	pi.sendUserMessage(
		[
			`Review feedback recorded for ${sLabel}. ${sourceNote}`,
			"",
			"Reviewer said:",
			`> ${result.feedback}`,
			"",
			`Now ask the user how to apply it, using tff_ask_user with id \`apply_${sLabel}\`, header "Apply review feedback", and three options:`,
			'  1) label "Apply inline (you approve patch)"',
			'     description "TFF proposes a minimal patch, runs lint/typecheck/test/build, then asks you to approve before push."',
			'  2) label "Edit manually"',
			'     description "Skip TFF — edit the worktree, push, then run /tff ship-merged."',
			'  3) label "Full TDD re-execute"',
			'     description "Reset tasks and re-run /tff execute with the feedback as context."',
			"",
			"After the user replies:",
			` - "Apply inline" → call tff_ship_fix({ sliceLabel: "${sLabel}" }).`,
			` - "Edit manually" → tell the user: edit the slice worktree, push to the slice branch, then run \`/tff ship-merged ${sLabel}\`.`,
			` - "Full TDD re-execute" → tell the user: run \`/tff execute ${sLabel}\` (tasks will be reset automatically).`,
		].join("\n"),
	);
}
