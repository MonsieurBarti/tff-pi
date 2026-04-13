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
				"Call AFTER the user confirms (via tff_ask_user) that the PR needs changes AND provides the reviewer feedback text. Flips the slice back to execute with the feedback attached. Pass the reviewer feedback verbatim — do NOT summarize.",
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
				const slice = resolveSlice(database, params.sliceLabel);
				if (!slice) {
					return {
						content: [{ type: "text", text: `Slice not found: ${params.sliceLabel}` }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				const result = handleShipChanges(pi, database, slice.id, params.feedback);
				if (!result.success) {
					return {
						content: [{ type: "text", text: result.message }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				// Slice is now `executing` with tasks reset. Tell the agent to
				// run /tff execute to re-enter with the feedback. We don't
				// auto-invoke runHeavyPhase here because this handler runs
				// inside the agent turn; the user will drive the next step
				// via /tff execute (or agent-suggested `/tff next`).
				return {
					content: [
						{
							type: "text",
							text: `${result.message}\n\nNext: tell the user to run \`/tff execute ${params.sliceLabel}\` (or \`/tff next\`) to apply the changes.`,
						},
					],
					details: { sliceLabel: params.sliceLabel, feedback: params.feedback },
				};
			},
		}),
	);
}
