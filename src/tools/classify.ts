import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb, resolveSlice } from "../common/context.js";
import { getSlice, updateSliceTier } from "../common/db.js";
import { isGateUnlocked } from "../common/discuss-gates.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { TIERS, type Tier } from "../common/types.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleClassify(db: Database.Database, sliceId: string, tier: Tier): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	if (!isGateUnlocked(sliceId, "tier_confirmed")) {
		return {
			content: [
				{
					type: "text",
					text: "Tier must be confirmed by the user. Propose a tier with justification and ask the user to confirm, then call tff_confirm_gate(sliceId, 'tier_confirmed').",
				},
			],
			details: { sliceId },
			isError: true,
		};
	}

	updateSliceTier(db, sliceId, tier);

	return {
		content: [
			{
				type: "text",
				text: `Slice ${sliceId} classified as Tier ${tier}`,
			},
		],
		details: { sliceId, tier },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_classify",
			label: "TFF Classify Slice",
			description:
				"Set the tier (complexity classification) of a slice. S = simple (skip research), SS = standard, SSS = complex. During interactive discuss, requires tier confirmation gate via tff_confirm_gate.",
			promptSnippet:
				"Call tff_confirm_gate('tier_confirmed') before calling tff_classify. The system enforces this.",
			promptGuidelines: [
				"Requires tier_confirmed gate — call tff_confirm_gate('tier_confirmed') first",
				"Propose a tier to the user, get confirmation, then call tff_confirm_gate, then tff_classify",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				tier: StringEnum([...TIERS], {
					description: "Tier: S (simple), SS (standard), SSS (complex)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const tier = TIERS.find((t) => t === params.tier);
					if (!tier) {
						return {
							content: [{ type: "text", text: `Invalid tier: ${params.tier}` }],
							details: { tier: params.tier },
							isError: true,
						};
					}
					const result = handleClassify(database, slice.id, tier);
					if (!result.isError && ctx.projectRoot) {
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							ctx.projectRoot,
							slice,
							"discuss",
							verifyPhaseArtifacts,
						);
					}
					return result;
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
