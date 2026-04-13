import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { loadPrTemplate, renderPrTemplate } from "../common/pr-template.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export interface WritePrParams {
	description: string;
	testSteps: string;
	trickyParts?: string | undefined;
	deploymentSteps?: string | undefined;
	envVars?: string | undefined;
}

export function handleWritePr(
	db: Database.Database,
	root: string,
	sliceId: string,
	params: WritePrParams,
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
	const path = `milestones/${mLabel}/slices/${label}/PR.md`;

	const template = loadPrTemplate(root);
	const body = renderPrTemplate(template, params);
	writeArtifact(root, path, body);

	return {
		content: [{ type: "text", text: `PR.md written for ${label}.` }],
		details: { sliceId, path },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_pr",
			label: "TFF Write PR Body",
			description:
				"Write the PR.md artifact (pull request description) by filling the project's PR template. Called during the verify phase after VERIFICATION.md, before ship. Project can override the template at .tff/templates/pr-body.md.",
			promptGuidelines: [
				"Call after VERIFICATION.md is written and tests pass",
				"Write concise, reviewer-facing copy — not internal process notes",
				"description: what the PR changes and why (2-5 sentences)",
				"testSteps: numbered steps a reviewer can follow to verify",
				"trickyParts: edge cases, trade-offs, or subtle implementation details (omit if none)",
				"deploymentSteps: migrations, config changes, manual steps (omit if none)",
				"envVars: new environment variables with purpose (omit if none)",
			],
			parameters: Type.Object({
				sliceId: Type.String({ description: "Slice ID (UUID) or label (e.g., M01-S01)" }),
				description: Type.String({ description: "What this PR changes or adds, and why" }),
				testSteps: Type.String({ description: "How a reviewer can test the PR (markdown)" }),
				trickyParts: Type.Optional(
					Type.String({ description: "Edge cases, trade-offs, impl details (markdown)" }),
				),
				deploymentSteps: Type.Optional(
					Type.String({ description: "Migrations, config changes (markdown)" }),
				),
				envVars: Type.Optional(
					Type.String({ description: "New environment variables (markdown)" }),
				),
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
					return handleWritePr(database, root, slice.id, {
						description: params.description,
						testSteps: params.testSteps,
						trickyParts: params.trickyParts,
						deploymentSteps: params.deploymentSteps,
						envVars: params.envVars,
					});
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
