import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { DISCUSS_GATES, unlockGate } from "../common/discuss-gates.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_confirm_gate",
			label: "TFF Confirm Gate",
			description:
				"Confirm a discuss-phase gate after user approval. Gates: 'depth_verified' (unlocks tff_write_spec) and 'tier_confirmed' (unlocks tff_classify). Only call after the user has explicitly confirmed.",
			promptGuidelines: [
				"Call with gate='depth_verified' after user confirms they're ready to write the spec",
				"Call with gate='tier_confirmed' after user confirms the proposed tier classification",
				"Do NOT call without explicit user confirmation",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				gate: StringEnum(["depth_verified", "tier_confirmed"], {
					description: "The gate to unlock: 'depth_verified' or 'tier_confirmed'",
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
					const gate = DISCUSS_GATES.find((g) => g === params.gate);
					if (!gate) {
						return {
							content: [{ type: "text", text: `Invalid gate: ${params.gate}` }],
							details: { gate: params.gate },
							isError: true,
						};
					}
					unlockGate(slice.id, gate);
					const gateLabel =
						params.gate === "depth_verified"
							? "Depth verified — tff_write_spec is now unlocked."
							: "Tier confirmed — tff_classify is now unlocked.";
					return {
						content: [{ type: "text", text: gateLabel }],
						details: { sliceId: slice.id, gate: params.gate },
					};
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
