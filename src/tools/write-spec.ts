import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { compressIfEnabled } from "../common/compress.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { appendCommand, updateLogCursor } from "../common/event-log.js";
import { makeBaseEvent } from "../common/events.js";
import { computeNextHint } from "../common/phase-completion.js";
import { requestReview } from "../common/plannotator-review.js";
import { projectCommand } from "../common/projection.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleWriteSpec(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
	settings: Settings = DEFAULT_SETTINGS,
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
	const path = `milestones/${mLabel}/slices/${label}/SPEC.md`;
	writeArtifact(root, path, compressIfEnabled(content, "artifacts", settings));
	db.transaction(() => {
		projectCommand(db, root, "write-spec", { sliceId: slice.id });
		const { hash, row } = appendCommand(root, "write-spec", { sliceId: slice.id });
		updateLogCursor(db, hash, row);
	})();
	return {
		content: [{ type: "text", text: `SPEC.md written for ${label}.` }],
		details: { sliceId, path },
	};
}

export function handleWriteRequirements(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
	settings: Settings = DEFAULT_SETTINGS,
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
	const path = `milestones/${mLabel}/slices/${label}/REQUIREMENTS.md`;
	writeArtifact(root, path, compressIfEnabled(content, "artifacts", settings));
	db.transaction(() => {
		projectCommand(db, root, "write-requirements", { sliceId: slice.id });
		const { hash, row } = appendCommand(root, "write-requirements", { sliceId: slice.id });
		updateLogCursor(db, hash, row);
	})();
	return {
		content: [{ type: "text", text: `REQUIREMENTS.md written for ${label}.` }],
		details: { sliceId, path },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_spec",
			label: "TFF Write Spec",
			description:
				"Write the SPEC.md artifact for a slice. IMPORTANT: After this tool returns successfully, STOP. Do not call any plannotator_* tools — TFF handles spec review automatically. If this tool returns an error with feedback, the user rejected the spec; revise and call this tool again.",
			promptSnippet:
				"After tff_write_spec succeeds, STOP — do not call plannotator tools. TFF handles review automatically.",
			promptGuidelines: [
				"Used during the discuss phase to write the spec after user confirms readiness",
				"IMPORTANT: Do not call plannotator tools after this tool returns. Review is automatic.",
				"If tool returns error with feedback, user rejected spec; revise and retry.",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the spec",
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
					const writeResult = handleWriteSpec(
						database,
						root,
						slice.id,
						params.content,
						ctx.settings ?? DEFAULT_SETTINGS,
					);
					if (!writeResult.isError) {
						const review = await requestReview(
							pi,
							String(writeResult.details.path),
							params.content,
							"spec",
						);
						if (!review.approved) {
							return {
								content: [
									{
										type: "text",
										text: `SPEC.md review rejected in plannotator.\nFeedback: ${review.feedback ?? "(none)"}\nAddress the feedback and call tff_write_spec again.`,
									},
								],
								details: {
									...writeResult.details,
									reviewRejected: true,
									feedback: review.feedback,
								},
								isError: true,
							};
						}
						const milestone = getMilestone(database, slice.milestoneId);
						if (!milestone) {
							return {
								content: [{ type: "text", text: `Milestone not found for slice: ${slice.id}` }],
								details: { sliceId: slice.id },
								isError: true,
							};
						}
						const label = sliceLabel(milestone.number, slice.number);
						pi.events.emit("tff:phase", {
							...makeBaseEvent(slice.id, label, milestone.number),
							type: "phase_complete",
							phase: "discuss",
						});
						const hint = computeNextHint(database, slice, milestone.number);
						return {
							...writeResult,
							content: [
								{
									type: "text" as const,
									text: `${writeResult.content[0]?.text ?? ""} Approved by plannotator — the gate has cleared.${hint ? ` Discuss phase complete. Stop here; the user will advance.\n\n${hint}` : ""}`,
								},
							],
						};
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
