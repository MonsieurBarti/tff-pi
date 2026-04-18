import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { handleShipMerged as commandHandleShipMerged } from "../commands/ship-merged.js";
import { commitCommand } from "../common/commit.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Pure (no git) handle function: projects the ship-merged command into the DB
 * and appends to the event log. Called by the tool's execute after the async
 * git cleanup is complete, and directly in unit tests.
 */
export function handleShipMerged(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceId: string,
	prUrl: string,
): ToolResult {
	// Block 1: validate
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found for slice: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	const sLabel = sliceLabel(milestone.number, slice.number);

	// Block 3: atomic DB mutation + event-log append in one transaction.
	// projectShipMerged: updateSlicePrUrl + overrideSliceStatus("closed") + completePhaseRun("ship").
	commitCommand(db, root, "ship-merged", { sliceId: slice.id, prUrl });

	// Block 4: post-commit bus emit
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_complete",
		phase: "ship",
	});

	return {
		content: [{ type: "text", text: `${sLabel} closed.` }],
		details: { sliceId: slice.id, prUrl },
	};
}

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
				try {
					// Async git cleanup (worktree removal, branch delete, pull).
					// This runs the full finalizeMergedSlice + squash check via the command.
					const gitResult = await commandHandleShipMerged(pi, database, root, slice.id);
					if (!gitResult.success) {
						return {
							content: [{ type: "text", text: gitResult.message }],
							details: { sliceLabel: params.sliceLabel },
							isError: true,
						};
					}
					// DB projection + event log: projectShipMerged handles
					// updateSlicePrUrl + overrideSliceStatus("closed") + completePhaseRun("ship").
					// The prUrl was already set on the slice during shipPhase; overrideSliceStatus
					// is idempotent with the call inside finalizeMergedSlice above.
					const prUrl = slice.prUrl ?? "";
					return handleShipMerged(pi, database, root, slice.id, prUrl);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
			},
		}),
	);
}
