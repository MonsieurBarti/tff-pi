import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { type TffContext, getDb, resolveSlice } from "../common/context.js";
import { getMilestone, getSlice, resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export type ReviewVerdict = "approved" | "denied";

/**
 * Writes REVIEW.md and, on 'denied' verdict, routes the slice back to
 * execute (resetting the listed tasks to 'open') so the agent can rework
 * the flagged issues. On 'approved' the slice stays in 'reviewing' and the
 * user can advance to ship via /tff next.
 */
export function handleWriteReview(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
	verdict: ReviewVerdict,
): ToolResult {
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
	const label = sliceLabel(milestone.number, slice.number);
	const mLabel = milestoneLabel(milestone.number);
	const path = `milestones/${mLabel}/slices/${label}/REVIEW.md`;
	writeArtifact(root, path, content);

	if (verdict === "denied") {
		resetTasksToOpen(db, sliceId);
		updateSliceStatus(db, sliceId, "executing");
		return {
			content: [
				{
					type: "text",
					text: `REVIEW.md written for ${label} (denied). Tasks reset to open; slice routed back to execute. Address the findings in REVIEW.md and re-run execute.`,
				},
			],
			details: { sliceId, path, verdict, routedTo: "executing" },
		};
	}

	return {
		content: [
			{
				type: "text",
				text: `REVIEW.md written for ${label} (approved). Run /tff next to proceed to ship.`,
			},
		],
		details: { sliceId, path, verdict },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_review",
			label: "TFF Write Review",
			description:
				"Write REVIEW.md for a slice AND submit the verdict. THIS IS THE ONLY TOOL THAT MARKS THE REVIEW PHASE COMPLETE — phase_complete fires here. On verdict='denied' the slice is routed back to execute with tasks reset to open.",
			promptSnippet:
				"The review phase is not complete until tff_write_review returns successfully. Pass verdict='approved' to unlock ship, or verdict='denied' to loop back to execute.",
			promptGuidelines: [
				"content must include findings list with file:line references",
				"Use verdict='approved' only when there are no blocking issues",
				"Use verdict='denied' when any finding blocks shipping; describe what task(s) need rework",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "Markdown content of REVIEW.md (summary + findings + tasksToRework)",
				}),
				verdict: StringEnum(["approved", "denied"] as const, {
					description:
						"approved = no blocking issues, unlocks ship. denied = loop back to execute with tasks reset.",
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
					const writeResult = handleWriteReview(
						database,
						root,
						slice.id,
						params.content,
						params.verdict as ReviewVerdict,
					);
					if (!writeResult.isError && params.verdict === "approved") {
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"review",
							verifyPhaseArtifacts,
						);
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
