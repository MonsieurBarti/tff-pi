import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TffContext } from "../common/context.js";
import { addRemote, initialCommitAndPush } from "../common/git.js";

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_add_remote",
			label: "TFF Add Remote",
			description:
				"Add a git remote origin and push the initial commit. Call this during /tff new when no remote is configured.",
			parameters: Type.Object({
				url: Type.String({
					description: "GitHub repository URL (e.g. https://github.com/user/repo.git)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const root = ctx.projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					const validHostPatterns = [
						/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//,
						/^git@(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org):/,
					];
					if (!validHostPatterns.some((p) => p.test(params.url))) {
						return {
							content: [
								{
									type: "text",
									text: "Error: URL must be from a known git host (github.com, gitlab.com, bitbucket.org, codeberg.org). If you need a different host, add the remote manually with `git remote add origin <url>`.",
								},
							],
							details: { url: params.url },
							isError: true,
						};
					}
					addRemote(params.url, root);
					initialCommitAndPush(root);
					return {
						content: [
							{
								type: "text",
								text: `Remote origin added (${params.url}) and initial commit pushed.`,
							},
						],
						details: { url: params.url },
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
						details: { url: params.url },
						isError: true,
					};
				}
			},
		}),
	);
}
