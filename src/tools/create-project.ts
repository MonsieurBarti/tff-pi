import type Database from "better-sqlite3";
import { type NewProjectInput, handleNew } from "../commands/new.js";
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
