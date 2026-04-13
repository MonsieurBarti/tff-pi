import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { initSliceDir } from "../common/artifacts.js";
import { type TffContext, findMilestoneByLabel, getDb } from "../common/context.js";
import { getMilestone, getNextSliceNumber, insertSlice } from "../common/db.js";
import { sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleCreateSlice(
	db: Database.Database,
	root: string,
	milestoneId: string,
	title: string,
): ToolResult {
	const milestone = getMilestone(db, milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found: ${milestoneId}` }],
			details: { milestoneId },
			isError: true,
		};
	}
	const number = getNextSliceNumber(db, milestoneId);
	const sliceId = insertSlice(db, { milestoneId, number, title });
	initSliceDir(root, milestone.number, number);
	const label = sliceLabel(milestone.number, number);
	return {
		content: [
			{
				type: "text",
				text: `Slice ${label} "${title}" created (id: ${sliceId}). Use this ID or '${label}' in subsequent tool calls. To begin working on this slice, tell the user to run \`/tff discuss ${label}\` (or \`/tff next\` if it's the active slice). Do NOT suggest a non-existent command like /tff start — the valid phase subcommands are: discuss, research, plan, execute, verify, ship, next.`,
			},
		],
		details: { sliceId, label, milestoneId, number },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_create_slice",
			label: "TFF Create Slice",
			description:
				"Create a new slice within a milestone. A slice is a unit of work that goes through the discuss → research → plan → execute → verify → ship lifecycle.",
			parameters: Type.Object({
				milestoneId: Type.String({
					description: "The ID or label (e.g. 'M01') of the milestone to add this slice to",
				}),
				title: Type.String({
					description: "Short descriptive title for the slice",
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
					const milestone =
						findMilestoneByLabel(database, params.milestoneId) ??
						getMilestone(database, params.milestoneId);
					if (!milestone) {
						return {
							content: [
								{ type: "text", text: `Error: Milestone not found: ${params.milestoneId}` },
							],
							details: { milestoneId: params.milestoneId },
							isError: true,
						};
					}
					return handleCreateSlice(database, root, milestone.id, params.title);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { milestoneId: params.milestoneId },
						isError: true,
					};
				}
			},
		}),
	);
}
