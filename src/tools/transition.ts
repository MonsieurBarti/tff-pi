import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb, resolveSlice } from "../common/context.js";
import { getSlice, updateSliceStatus } from "../common/db.js";
import { SLICE_TRANSITIONS, canTransitionSlice, nextSliceStatus } from "../common/state-machine.js";
import { SLICE_STATUSES, type SliceStatus } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleTransition(
	db: Database.Database,
	sliceId: string,
	targetStatus?: string,
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	if (targetStatus && !(SLICE_STATUSES as readonly string[]).includes(targetStatus)) {
		return {
			content: [
				{
					type: "text",
					text: `Invalid status: ${targetStatus}. Valid: ${SLICE_STATUSES.join(", ")}`,
				},
			],
			details: { sliceId, targetStatus },
			isError: true,
		};
	}

	const target = targetStatus
		? (targetStatus as SliceStatus)
		: nextSliceStatus(slice.status, slice.tier ?? undefined);

	if (!target) {
		return {
			content: [{ type: "text", text: `No valid next status from '${slice.status}'.` }],
			details: { sliceId, currentStatus: slice.status },
			isError: true,
		};
	}

	if (!canTransitionSlice(slice.status, target)) {
		return {
			content: [
				{
					type: "text",
					text: `Invalid transition: '${slice.status}' → '${target}'. Allowed from '${slice.status}': ${SLICE_TRANSITIONS[slice.status].join(", ")}`,
				},
			],
			details: { sliceId, from: slice.status, to: target },
			isError: true,
		};
	}

	updateSliceStatus(db, sliceId, target);

	return {
		content: [
			{
				type: "text",
				text: `Slice ${sliceId} transitioned: ${slice.status} → ${target}`,
			},
		],
		details: { sliceId, from: slice.status, to: target },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_transition",
			label: "TFF Transition Slice",
			description:
				"Transition a slice to a new status. Validates the transition is allowed by the state machine. If targetStatus is omitted, advances to the next status. IMPORTANT: Only call this tool when the user explicitly asks to advance phases. Never transition on your own initiative after a tool call.",
			promptSnippet:
				"IMPORTANT: Only call tff_transition when the user explicitly asks to advance phases. Never transition on your own initiative after a tool call.",
			promptGuidelines: [
				"Do NOT call tff_transition automatically after writing specs or plans",
				"Always ask the user before transitioning to the next phase",
				"Users advance phases explicitly with `/tff next` or the specific phase command",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				targetStatus: Type.Optional(
					StringEnum([...SLICE_STATUSES], {
						description:
							"The target status to transition to. If omitted, advances to the next logical status.",
					}),
				),
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
					return handleTransition(database, slice.id, params.targetStatus);
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
