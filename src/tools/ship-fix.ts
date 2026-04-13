import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone } from "../common/db.js";
import { type PhaseContext, runPhaseWithFreshContext } from "../common/phase.js";
import { DEFAULT_SETTINGS } from "../common/settings.js";
import type { Phase } from "../common/types.js";
import { shipFixPhase } from "../phases/ship-fix.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_ship_fix",
			label: "TFF Ship: Inline Fix",
			description:
				"Launch the inline-fix agent for a slice that has REVIEW_FEEDBACK.md. Opens a fresh PI session with the ship-fix protocol: read feedback, apply minimal patch, run lint/typecheck/test/build, ask the user to approve before commit+push. Call AFTER the user picks 'Apply inline' at the ship-changes gate.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
			}),
			async execute(_id, params) {
				const database = getDb(ctx);
				const root = ctx.projectRoot;
				if (!root) {
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
				const milestone = getMilestone(database, slice.milestoneId);
				if (!milestone) {
					return {
						content: [{ type: "text", text: "Milestone not found for slice." }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				const phaseCtx: PhaseContext = {
					pi,
					db: database,
					root,
					slice,
					milestoneNumber: milestone.number,
					settings: ctx.settings ?? DEFAULT_SETTINGS,
					fffBridge: ctx.fffBridge,
				};
				const result = await runPhaseWithFreshContext({
					phaseModule: shipFixPhase,
					phaseCtx,
					cmdCtx: ctx.cmdCtx,
					// ship-fix is a side-channel phase; reuse "ship" for the
					// session lock so recovery tooling recognizes it.
					phase: "ship" as Phase,
				});
				if (!result.success) {
					return {
						content: [
							{
								type: "text",
								text: `Ship-fix failed: ${result.error ?? "unknown error"}`,
							},
						],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Ship-fix session dispatched for ${params.sliceLabel}. The inline-fix agent will take over.`,
						},
					],
					details: { sliceLabel: params.sliceLabel },
				};
			},
		}),
	);
}
