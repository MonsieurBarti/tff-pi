import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { commitCommand } from "../common/commit.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { type PhaseContext, runPhaseWithFreshContext } from "../common/phase.js";
import { DEFAULT_SETTINGS } from "../common/settings.js";
import { sliceLabel } from "../common/types.js";
import { shipFixPhase } from "../phases/ship-fix.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Pure (synchronous) handle function: projects the ship-fix command into the DB
 * and appends to the event log. projectShipFix marks the ship phase_run as
 * failed + reconciles status. Called before spawning the async PI session.
 */
export function handleShipFix(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceId: string,
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
	// projectShipFix marks ship phase_run as failed + reconciles slice status.
	commitCommand(db, root, "ship-fix", { sliceId: slice.id });

	// Block 4: post-commit bus emit
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_failed",
		phase: "ship",
	});

	return {
		content: [{ type: "text", text: `Ship-fix session dispatched for ${sLabel}.` }],
		details: { sliceId: slice.id },
	};
}

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
				try {
					// Record the ship-fix event + project command (marks ship phase_run failed).
					const logResult = handleShipFix(pi, database, root, slice.id);
					if (logResult.isError) return logResult;

					// Spawn the async PI session for the inline-fix agent.
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
						phase: "ship-fix",
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
					return logResult;
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
