import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { appendCommand, updateLogCursor } from "../common/event-log.js";
import { makeBaseEvent } from "../common/events.js";
import { computeNextHint } from "../common/phase-completion.js";
import { projectCommand } from "../common/projection.js";
import { TIERS, type Tier, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleClassify(
	db: Database.Database,
	root: string,
	sliceId: string,
	tier: Tier,
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	db.transaction(() => {
		projectCommand(db, root, "classify", { sliceId: slice.id, tier });
		const { hash, row } = appendCommand(root, "classify", { sliceId: slice.id, tier });
		updateLogCursor(db, hash, row);
	})();

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
				"Set the tier (complexity classification) of a slice. S = simple (skip research), SS = standard, SSS = complex.",
			promptGuidelines: [
				"Propose a tier in conversation, then call tff_classify with the user-confirmed tier",
				"Use S to skip the research phase entirely (simple slices), SS for standard, SSS for complex",
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
					const root = ctx.projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					const result = handleClassify(database, root, slice.id, tier);
					if (!result.isError) {
						const milestone = getMilestone(database, slice.milestoneId);
						if (milestone) {
							const label = sliceLabel(milestone.number, slice.number);
							pi.events.emit("tff:phase", {
								...makeBaseEvent(slice.id, label, milestone.number),
								type: "phase_complete",
								phase: "discuss",
							});
							const hint = computeNextHint(database, slice, milestone.number);
							if (hint) {
								return {
									...result,
									content: [
										{
											type: "text" as const,
											text: `${result.content[0]?.text ?? ""}\n\nDiscuss phase complete. Stop here; the user will advance.\n\n${hint}`,
										},
									],
								};
							}
						}
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
