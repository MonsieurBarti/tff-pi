import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { commitCommand } from "../common/commit.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { computeNextHint } from "../common/phase-completion.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

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
 * user can advance to ship via /tff ship.
 */
export function handleWriteReview(
	pi: ExtensionAPI,
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
		commitCommand(db, root, "review-rejected", { sliceId: slice.id });

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, label, milestone.number),
			type: "phase_failed",
			phase: "review",
			error: "Review verdict: denied",
		});
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

	// Approved: commit (phase_run completed + event log).
	commitCommand(db, root, "write-review", { sliceId: slice.id });

	return {
		content: [
			{
				type: "text",
				text: `REVIEW.md written for ${label} (approved).`,
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
						pi,
						database,
						root,
						slice.id,
						params.content,
						params.verdict as ReviewVerdict,
					);
					if (!writeResult.isError && params.verdict === "approved") {
						const milestone = getMilestone(database, slice.milestoneId);
						if (milestone) {
							const sLabel = sliceLabel(milestone.number, slice.number);
							pi.events.emit("tff:phase", {
								...makeBaseEvent(slice.id, sLabel, milestone.number),
								type: "phase_complete",
								phase: "review",
							});
							const hint = computeNextHint(database, slice, milestone.number);
							if (hint) {
								return {
									...writeResult,
									content: [
										{
											type: "text" as const,
											text: `${writeResult.content[0]?.text ?? ""} Review phase complete. Stop here; the user will advance.\n\n${hint}`,
										},
									],
								};
							}
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
