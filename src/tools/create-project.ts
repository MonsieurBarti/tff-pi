import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type NewProjectInput, handleNew } from "../commands/new.js";
import { type TffContext, getDb } from "../common/context.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleCreateProject(
	db: Database.Database,
	root: string,
	input: NewProjectInput,
	settings: Settings = DEFAULT_SETTINGS,
): ToolResult {
	try {
		const { projectId } = handleNew(db, root, input, settings);
		return {
			content: [
				{
					type: "text",
					text: `Project "${input.projectName}" created (id: ${projectId}). Use /tff new-milestone to add a milestone.`,
				},
			],
			details: { projectId },
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
			details: {},
			isError: true,
		};
	}
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_create_project",
			label: "TFF Create Project",
			description:
				"Create a new TFF project with name and vision. Call this after brainstorming with the user via /tff new. Use /tff new-milestone to add milestones afterwards.",
			parameters: Type.Object({
				projectName: Type.String({ description: "Name of the project" }),
				vision: Type.String({ description: "Vision statement for the project" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const database = getDb(ctx);
				const root = ctx.projectRoot;
				if (!root) {
					return {
						content: [{ type: "text", text: "Error: No project root found." }],
						details: {},
						isError: true,
					};
				}
				return handleCreateProject(
					database,
					root,
					{
						projectName: params.projectName,
						vision: params.vision,
					},
					ctx.settings ?? DEFAULT_SETTINGS,
				);
			},
		}),
	);
}
