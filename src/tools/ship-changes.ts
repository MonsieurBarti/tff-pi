import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { commitCommand } from "../common/commit.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { fetchReviewFeedback } from "../common/review-feedback.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export async function handleShipChanges(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceId: string,
	feedback?: string,
): Promise<ToolResult> {
	// Block 1: validate
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	if (slice.status === "closed") {
		return {
			content: [
				{
					type: "text",
					text: `Slice ${sliceId} is already closed — cannot accept change requests.`,
				},
			],
			details: { sliceId },
			isError: true,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found for slice ${sliceId}.` }],
			details: { sliceId },
			isError: true,
		};
	}

	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);

	// Block 2: side-effect work (fetch feedback + write artifact)
	const provided = (feedback ?? "").trim();
	let effectiveFeedback: string;
	let autoFetched = false;

	if (provided.length > 0) {
		effectiveFeedback = provided;
	} else {
		if (!slice.prUrl) {
			return {
				content: [
					{
						type: "text",
						text: "No PR URL on slice — open the PR with `/tff ship` first, or pass the reviewer feedback text explicitly.",
					},
				],
				details: { sliceId },
				isError: true,
			};
		}
		const fetched = fetchReviewFeedback(slice.prUrl);
		if (!fetched) {
			return {
				content: [
					{
						type: "text",
						text: `PR has no review feedback yet on ${slice.prUrl}. Pass the feedback text explicitly if you want to record it.`,
					},
				],
				details: { sliceId },
				isError: true,
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

	// Block 3: atomic DB mutation + event-log append in one transaction
	commitCommand(db, root, "ship-changes", { sliceId: slice.id });

	// Block 4: post-commit bus emit
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_failed",
		phase: "ship",
		error: "PR review requested changes",
	});

	const sourceNote = autoFetched
		? "auto-fetched from gh pr view"
		: "recorded from the text you passed";
	return {
		content: [
			{
				type: "text",
				text: `Review feedback recorded for ${sLabel}. (${sourceNote})\n\nNow call tff_ask_user (id \`apply_${sLabel}\`) with three options: "Apply inline (you approve patch)", "Edit manually", "Full TDD re-execute". On "Apply inline" → call tff_ship_fix({ sliceLabel: "${sLabel}" }). On "Edit manually" → tell the user to edit the worktree, push, then run \`/tff ship-merged ${sLabel}\`. On "Full TDD re-execute" → tell the user to run \`/tff execute ${sLabel}\`.`,
			},
		],
		details: {
			sliceId: slice.id,
			autoFetched,
		},
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_ship_changes",
			label: "TFF Ship: Changes Requested",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the PR needs changes. If `feedback` is omitted, TFF fetches the reviewer feedback automatically from `gh pr view`. Pass `feedback` verbatim only when the user explicitly supplies the text — do NOT summarize. Stashes the feedback as REVIEW_FEEDBACK.md under the slice artifact dir and leaves the slice in `shipping`.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
				feedback: Type.Optional(
					Type.String({
						description:
							"Optional. Reviewer's change-request text, verbatim. Omit to auto-fetch via gh pr view.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const database = getDb(ctx);
				if (!ctx.projectRoot) {
					return {
						content: [{ type: "text", text: "TFF project root not initialized." }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				const slice = resolveSlice(database, params.sliceLabel);
				if (!slice) {
					return {
						content: [{ type: "text", text: `Slice not found: ${params.sliceLabel}` }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				try {
					return await handleShipChanges(pi, database, ctx.projectRoot, slice.id, params.feedback);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
			},
		}),
	);
}
