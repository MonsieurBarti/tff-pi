import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createCheckpoint } from "../common/checkpoint.js";
import type { TffContext } from "../common/context.js";
import { getWorktreePath } from "../common/worktree.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_checkpoint",
			label: "TFF Create Checkpoint",
			description:
				"Create a git checkpoint tag at the current state of the slice's worktree. Call after completing each execution wave. Example: tff_checkpoint({ sliceLabel: 'M01-S01', name: 'wave-1' })",
			parameters: Type.Object({
				sliceLabel: Type.String({ description: "Slice label (e.g., M01-S01)" }),
				name: Type.String({ description: "Checkpoint name (e.g., wave-1, wave-2)" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const root = ctx.projectRoot;
				if (!root) {
					return {
						content: [
							{ type: "text", text: "Error: No project root. TFF may not be initialized." },
						],
						details: {},
						isError: true,
					};
				}
				const wtPath = getWorktreePath(root, params.sliceLabel);
				try {
					createCheckpoint(wtPath, params.sliceLabel, params.name);
					const tag = `checkpoint/${params.sliceLabel}/${params.name}`;
					return {
						content: [{ type: "text", text: `Created checkpoint: ${tag}` }],
						details: { checkpoint: tag },
					};
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceLabel: params.sliceLabel, name: params.name },
						isError: true,
					};
				}
			},
		}),
	);
}
