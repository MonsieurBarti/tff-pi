import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { handleCompleteMilestoneChanges } from "../commands/complete-milestone-changes.js";
import { type TffContext, getDb } from "../common/context.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_complete_milestone_changes",
			label: "TFF Complete Milestone: Changes Requested",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the MILESTONE PR needs changes. Pass the user's feedback verbatim. Writes MILESTONE_REVIEW_FEEDBACK.md under the milestone dir; the milestone stays in 'completing' until the user re-runs /tff complete-milestone-merged after fixing.",
			parameters: Type.Object({
				milestoneLabel: Type.String({
					description: "Milestone label (e.g., M10) or milestone id",
				}),
				feedback: Type.String({
					description: "Reviewer's change-request text, verbatim. Required.",
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
				const result = await handleCompleteMilestoneChanges(
					pi,
					database,
					root,
					params.milestoneLabel,
					params.feedback,
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
