import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleExecuteDone(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceRef: string,
): ToolResult {
	const slice = resolveSlice(db, sliceRef);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceRef}` }],
			details: { sliceRef },
			isError: true,
		};
	}
	if (slice.status !== "executing") {
		return {
			content: [
				{
					type: "text",
					text: `Cannot mark execute done: slice ${sliceRef} is in '${slice.status}' status (expected 'executing').`,
				},
			],
			details: { sliceId: slice.id, status: slice.status },
			isError: true,
		};
	}
	const hint = emitPhaseCompleteIfArtifactsReady(
		pi,
		db,
		root,
		slice,
		"execute",
		verifyPhaseArtifacts,
	);
	return {
		content: [
			{
				type: "text",
				text: `Execute phase marked complete for slice ${sliceRef}. Stop here. The user will advance to verify.${hint ? `\n\n${hint}` : ""}`,
			},
		],
		details: { sliceId: slice.id },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_execute_done",
			label: "TFF Execute Done",
			description:
				"Signal that the execute phase is complete. Call this exactly once, after all code edits, commits, and wave checkpoints for the slice are finished. Emits phase_complete for execute so the user receives the → Next: /tff verify M##-S## hint. STOP after this tool returns.",
			promptSnippet:
				"Call tff_execute_done at the very end of the execute phase — after the final wave checkpoint. Without it, the user has no signal that execute finished and no hint for what to run next.",
			promptGuidelines: [
				"Call exactly once, as the last action of execute",
				"Must come AFTER all tff_checkpoint calls for each wave",
				"Slice must be in 'executing' status; call sequence violations return an error",
				"After this tool returns, STOP — do not call /tff verify yourself",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
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
					return handleExecuteDone(pi, database, root, params.sliceId);
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);
}
