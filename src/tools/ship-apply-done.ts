import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone } from "../common/db.js";
import { appendCommand, updateLogCursor } from "../common/event-log.js";
import { makeBaseEvent } from "../common/events.js";
import { projectCommand } from "../common/projection.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ShipApplyDoneInput {
	sliceLabel: string;
	rejected?: boolean | undefined;
}

export function handleShipApplyDone(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	input: ShipApplyDoneInput,
): { success: boolean; message: string } {
	// Block 1: validate
	const slice = resolveSlice(db, input.sliceLabel);
	if (!slice) return { success: false, message: `Slice not found: ${input.sliceLabel}` };
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return { success: false, message: "Milestone not found." };

	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);

	// Block 2: side-effect work (clean up artifact)
	const feedbackPath = join(
		root,
		".tff",
		"milestones",
		mLabel,
		"slices",
		sLabel,
		"REVIEW_FEEDBACK.md",
	);
	if (existsSync(feedbackPath)) {
		try {
			unlinkSync(feedbackPath);
		} catch {
			// non-fatal — artifact gets overwritten on next ship-changes
		}
	}

	// Block 3: atomic DB mutation + event-log append in one transaction.
	// projectPhaseComplete("ship") completes the ship phase_run + reconciles status.
	db.transaction(() => {
		projectCommand(db, root, "ship-apply-done", { sliceId: slice.id });
		const { hash, row } = appendCommand(root, "ship-apply-done", { sliceId: slice.id });
		updateLogCursor(db, hash, row);
	})();

	// Block 4: post-commit bus emit
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: input.rejected ? "phase_failed" : "phase_complete",
		phase: "ship-fix",
	});

	return {
		success: true,
		message: input.rejected
			? `${sLabel} inline fix rejected. REVIEW_FEEDBACK.md cleared. Run /tff ship-changes again or fix manually.`
			: `${sLabel} inline fix applied. PR updated. When merged, run /tff ship-merged.`,
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_ship_apply_done",
			label: "TFF Ship: Apply Done",
			description:
				"Call AFTER the inline-fix agent has either committed+pushed (rejected=false) or reverted the worktree (rejected=true). Cleans up REVIEW_FEEDBACK.md and notifies the user. Only use during the ship-fix phase.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
				rejected: Type.Optional(
					Type.Boolean({
						description: "true if the user rejected the patch (defaults to false)",
					}),
				),
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
				const input: ShipApplyDoneInput = { sliceLabel: params.sliceLabel };
				if (params.rejected !== undefined) input.rejected = params.rejected;
				const result = handleShipApplyDone(pi, database, root, input);
				return {
					content: [{ type: "text", text: result.message }],
					details: { sliceLabel: params.sliceLabel },
					isError: !result.success,
				};
			},
		}),
	);
}
