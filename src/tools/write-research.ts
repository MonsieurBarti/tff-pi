import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { compressIfEnabled } from "../common/compress.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleWriteResearch(
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
	const path = `milestones/${mLabel}/slices/${label}/RESEARCH.md`;
	writeArtifact(root, path, compressIfEnabled(content, "artifacts", settings));
	return {
		content: [{ type: "text", text: `RESEARCH.md written for ${label}.` }],
		details: { sliceId, path },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_research",
			label: "TFF Write Research",
			description:
				"Write the RESEARCH.md artifact for a slice. Called by the researcher agent during the research phase. Do NOT call directly — use /tff research instead.",
			promptSnippet:
				"Do NOT call tff_write_research directly. Use /tff research <slice> to run the research phase.",
			promptGuidelines: [
				"This tool is for sub-agents during phase execution, not for direct use",
				"To write research, tell the user to run /tff research <slice>",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the research document",
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
					const writeResult = handleWriteResearch(
						database,
						root,
						slice.id,
						params.content,
						ctx.settings ?? DEFAULT_SETTINGS,
					);
					if (!writeResult.isError) {
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"research",
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
