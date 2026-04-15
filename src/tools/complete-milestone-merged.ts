import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { handleCompleteMilestoneMerged } from "../commands/complete-milestone-merged.js";
import { type TffContext, getDb } from "../common/context.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_complete_milestone_merged",
			label: "TFF Complete Milestone: PR Merged",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the MILESTONE PR was merged on GitHub. Closes the milestone, merges tff-state/<milestoneBranch> into the parent state branch, tombstones the state branch, and deletes it. Do NOT call this without explicit user confirmation.",
			parameters: Type.Object({
				milestoneLabel: Type.String({
					description: "Milestone label (e.g., M10) or milestone id",
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
				const result = await handleCompleteMilestoneMerged(
					pi,
					database,
					root,
					params.milestoneLabel,
					ctx.settings ?? undefined,
				);
				return {
					content: [{ type: "text", text: result.message }],
					details: { milestoneLabel: params.milestoneLabel },
					isError: !result.success,
				};
			},
		}),
	);
}
