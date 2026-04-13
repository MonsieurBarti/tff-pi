import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { handleShipChanges } from "../commands/ship-changes.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_ship_changes",
			label: "TFF Ship: Changes Requested",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the PR needs changes AND provides the reviewer feedback text. Stashes the feedback as REVIEW_FEEDBACK.md under the slice artifact dir and leaves the slice in `shipping`. The user then decides: small edits in the worktree followed by `/tff ship-merged`, or a full `/tff execute` re-entry. Pass the reviewer feedback verbatim — do NOT summarize.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
				feedback: Type.String({
					description: "Reviewer's change request text, verbatim from the user's message",
				}),
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
				const result = handleShipChanges(pi, database, ctx.projectRoot, slice.id, params.feedback);
				if (!result.success) {
					return {
						content: [{ type: "text", text: result.message }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				// Feedback has been stashed under REVIEW_FEEDBACK.md. Slice stays
				// in `shipping` — the user decides whether to do a small fix
				// (edit worktree + /tff ship-merged) or re-run /tff execute.
				return {
					content: [
						{
							type: "text",
							text: `${result.message}\n\nReview feedback saved to REVIEW_FEEDBACK.md. Tell the user: for a small fix, edit the worktree and push to the slice branch then run \`/tff ship-merged ${params.sliceLabel}\`. For a larger fix, run \`/tff execute ${params.sliceLabel}\` to re-enter TDD.`,
						},
					],
					details: { sliceLabel: params.sliceLabel, feedback: params.feedback },
				};
			},
		}),
	);
}
