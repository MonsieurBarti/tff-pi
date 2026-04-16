import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { requestReview } from "../common/plannotator-review.js";
import { DEFAULT_SETTINGS } from "../common/settings.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";
import { handleWriteRequirements } from "./write-spec.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_requirements",
			label: "TFF Write Requirements",
			description:
				"Write the REQUIREMENTS.md artifact for a slice. Used during the discuss phase alongside SPEC.md. IMPORTANT: After this tool returns successfully, STOP. Do not call any plannotator_* tools — TFF handles requirements review automatically. If this tool returns an error with feedback, the user rejected the requirements; revise and call this tool again.",
			promptGuidelines: [
				"Write REQUIREMENTS.md with R-IDs, classes, acceptance conditions, and verification instructions",
				"Used during the discuss phase after writing SPEC.md",
				"IMPORTANT: Do not call plannotator tools after this tool returns. Review is automatic.",
				"If tool returns error with feedback, user rejected requirements; revise and retry.",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the requirements",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const root = ctx.projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const writeResult = handleWriteRequirements(
						database,
						root,
						slice.id,
						params.content,
						ctx.settings ?? DEFAULT_SETTINGS,
					);
					if (!writeResult.isError) {
						const review = await requestReview(
							pi,
							String(writeResult.details.path),
							params.content,
							"spec",
						);
						if (!review.approved) {
							return {
								content: [
									{
										type: "text",
										text: `REQUIREMENTS.md review rejected in plannotator.\nFeedback: ${review.feedback ?? "(none)"}\nAddress the feedback and call tff_write_requirements again.`,
									},
								],
								details: {
									...writeResult.details,
									reviewRejected: true,
									feedback: review.feedback,
								},
								isError: true,
							};
						}
						const hint = emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"discuss",
							verifyPhaseArtifacts,
						);
						if (hint) {
							return {
								...writeResult,
								content: [
									{
										type: "text" as const,
										text: `${writeResult.content[0]?.text ?? ""} Discuss phase complete. Stop here; the user will advance.\n\n${hint}`,
									},
								],
							};
						}
					}
					return writeResult;
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);
}
