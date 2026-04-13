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
				const result = await handleShipChanges(
					pi,
					database,
					ctx.projectRoot,
					slice.id,
					params.feedback,
				);
				if (!result.success) {
					return {
						content: [{ type: "text", text: result.message }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				const sourceNote = result.autoFetched
					? "auto-fetched from gh pr view"
					: "recorded from the text you passed";
				return {
					content: [
						{
							type: "text",
							text: `${result.message} (${sourceNote})\n\nNow call tff_ask_user (id \`apply_${params.sliceLabel}\`) with three options: "Apply inline (you approve patch)", "Edit manually", "Full TDD re-execute". On "Apply inline" → call tff_ship_fix({ sliceLabel: "${params.sliceLabel}" }). On "Edit manually" → tell the user to edit the worktree, push, then run \`/tff ship-merged ${params.sliceLabel}\`. On "Full TDD re-execute" → tell the user to run \`/tff execute ${params.sliceLabel}\`.`,
						},
					],
					details: {
						sliceLabel: params.sliceLabel,
						autoFetched: result.autoFetched,
					},
				};
			},
		}),
	);
}
