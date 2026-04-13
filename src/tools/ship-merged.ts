import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { handleShipMerged } from "../commands/ship-merged.js";
import { type TffContext, getDb, resolveSlice } from "../common/context.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_ship_merged",
			label: "TFF Ship: PR Merged",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the slice PR was merged on GitHub. Cleans up the worktree, deletes the slice branch, pulls the milestone branch, and closes the slice. Do NOT call this without explicit user confirmation.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const database = getDb(ctx);
				const root = ctx.projectRoot;
				if (!root) {
					return {
						content: [{ type: "text", text: "Error: No project root." }],
						details: {},
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
				const result = handleShipMerged(pi, database, root, slice.id);
				return {
					content: [{ type: "text", text: result.message }],
					details: { sliceLabel: params.sliceLabel },
					isError: !result.success,
				};
			},
		}),
	);
}
