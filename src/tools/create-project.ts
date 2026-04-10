import type Database from "better-sqlite3";
import { type NewProjectInput, handleNew } from "../commands/new.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleCreateProject(
	db: Database.Database,
	root: string,
	input: NewProjectInput,
): ToolResult {
	try {
		const { projectId, milestoneId } = handleNew(db, root, input);
		return {
			content: [
				{
					type: "text",
					text: `Project "${input.projectName}" created with milestone M01 "${input.milestoneName}" and ${input.slices.length} slice(s).`,
				},
			],
			details: { projectId, milestoneId, sliceCount: input.slices.length },
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
