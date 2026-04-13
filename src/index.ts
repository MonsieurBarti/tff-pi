import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { COMMANDS } from "./commands/registry.js";
import { handleShipChanges } from "./commands/ship-changes.js";
import { handleShipMerged } from "./commands/ship-merged.js";
import { createCheckpoint } from "./common/checkpoint.js";
import {
	createTffContext,
	findMilestoneByLabel,
	getDb,
	resolveMilestone,
	resolveSlice,
} from "./common/context.js";
import { getMilestone } from "./common/db.js";
import { DISCUSS_GATES, unlockGate } from "./common/discuss-gates.js";
import { addRemote, initialCommitAndPush } from "./common/git.js";
import { emitPhaseCompleteIfArtifactsReady } from "./common/phase-completion.js";
import { requestReview } from "./common/plannotator-review.js";
import { VALID_SUBCOMMANDS, isValidSubcommand, parseSubcommand } from "./common/router.js";
import { DEFAULT_SETTINGS } from "./common/settings.js";
import { SLICE_STATUSES, TIERS } from "./common/types.js";
import { getWorktreePath } from "./common/worktree.js";
import { registerLifecycleHooks } from "./lifecycle.js";
import { verifyPhaseArtifacts } from "./orchestrator.js";
import { type AskUserQuestion, handleAskUser } from "./tools/ask-user.js";
import { handleClassify } from "./tools/classify.js";
import { handleCreateProject } from "./tools/create-project.js";
import { handleCreateSlice } from "./tools/create-slice.js";
import { queryState } from "./tools/query-state.js";
import { handleTransition } from "./tools/transition.js";
import { handleWritePlan } from "./tools/write-plan.js";
import { handleWriteResearch } from "./tools/write-research.js";
import { type ReviewVerdict, handleWriteReview } from "./tools/write-review.js";
import { handleWriteRequirements, handleWriteSpec } from "./tools/write-spec.js";
import { handleWriteVerification } from "./tools/write-verification.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function tffExtension(pi: ExtensionAPI): void {
	const ctx = createTffContext(pi);

	registerLifecycleHooks(pi, ctx);

	// -------------------------------------------------------------------------
	// /tff command
	// -------------------------------------------------------------------------
	pi.registerCommand("tff", {
		description:
			"The Forge Flow — project workflow manager. Subcommands: new, status, progress, health, settings, help (and more)",
		getArgumentCompletions: (prefix: string) => {
			const { subcommand, args } = parseSubcommand(prefix);
			// Only suggest subcommands when the user hasn't completed the first word yet
			if (args.length > 0) return null;
			const items = VALID_SUBCOMMANDS.filter((cmd) => cmd.startsWith(subcommand)).map((cmd) => ({
				value: cmd,
				label: cmd,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (input, uiCtx) => {
			ctx.cmdCtx = uiCtx;
			const { subcommand, args } = parseSubcommand(input);

			if (!isValidSubcommand(subcommand)) {
				if (uiCtx.hasUI) {
					uiCtx.ui.notify(
						`Unknown subcommand: ${subcommand}. Run \`/tff help\` for usage.`,
						"error",
					);
				}
				return;
			}

			const handler = COMMANDS.get(subcommand);
			if (!handler) {
				// Should be unreachable thanks to the structural test in
				// tests/unit/structural/commands.spec.ts, but belt-and-braces for
				// runtime safety.
				if (uiCtx.hasUI) {
					uiCtx.ui.notify(`No handler registered for /tff ${subcommand}.`, "error");
				}
				return;
			}

			await handler(pi, ctx, uiCtx, args);
		},
	});

	// -------------------------------------------------------------------------
	// AI Tool: tff_query_state
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_query_state",
			label: "TFF Query State",
			description:
				"Query the current TFF project state. Use scope=overview for project + milestones, scope=milestone with an id for slices, or scope=slice with an id for tasks and dependencies.",
			parameters: Type.Object({
				scope: StringEnum(["overview", "milestone", "slice"] as const, {
					description: "What to query: overview, a specific milestone, or a specific slice",
				}),
				id: Type.Optional(
					Type.String({
						description:
							"Milestone ID (UUID) or label (e.g., M01) for scope=milestone; slice ID (UUID) or label (e.g., M01-S01) for scope=slice",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					let result: unknown;
					if (params.scope === "overview") {
						result = queryState(database, "overview");
					} else if (params.scope === "milestone") {
						const milestone = params.id ? resolveMilestone(database, params.id) : null;
						result = queryState(database, "milestone", milestone?.id ?? params.id ?? "");
					} else {
						const slice = params.id ? resolveSlice(database, params.id) : null;
						result = queryState(database, "slice", slice?.id ?? params.id ?? "");
					}
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: { scope: params.scope, id: params.id },
					};
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { scope: params.scope, id: params.id },
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_transition
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_transition",
			label: "TFF Transition Slice",
			description:
				"Transition a slice to a new status. Validates the transition is allowed by the state machine. If targetStatus is omitted, advances to the next status. IMPORTANT: Only call this tool when the user explicitly asks to advance phases. Never transition on your own initiative after a tool call.",
			promptSnippet:
				"IMPORTANT: Only call tff_transition when the user explicitly asks to advance phases. Never transition on your own initiative after a tool call.",
			promptGuidelines: [
				"Do NOT call tff_transition automatically after writing specs or plans",
				"Always ask the user before transitioning to the next phase",
				"Users advance phases explicitly with `/tff next` or the specific phase command",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				targetStatus: Type.Optional(
					StringEnum([...SLICE_STATUSES], {
						description:
							"The target status to transition to. If omitted, advances to the next logical status.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					return handleTransition(database, slice.id, params.targetStatus);
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_classify
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_classify",
			label: "TFF Classify Slice",
			description:
				"Set the tier (complexity classification) of a slice. S = simple (skip research), SS = standard, SSS = complex. During interactive discuss, requires tier confirmation gate via tff_confirm_gate.",
			promptSnippet:
				"Call tff_confirm_gate('tier_confirmed') before calling tff_classify. The system enforces this.",
			promptGuidelines: [
				"Requires tier_confirmed gate — call tff_confirm_gate('tier_confirmed') first",
				"Propose a tier to the user, get confirmation, then call tff_confirm_gate, then tff_classify",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				tier: StringEnum([...TIERS], {
					description: "Tier: S (simple), SS (standard), SSS (complex)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const tier = TIERS.find((t) => t === params.tier);
					if (!tier) {
						return {
							content: [{ type: "text", text: `Invalid tier: ${params.tier}` }],
							details: { tier: params.tier },
							isError: true,
						};
					}
					const result = handleClassify(database, slice.id, tier);
					if (!result.isError && ctx.projectRoot) {
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							ctx.projectRoot,
							slice,
							"discuss",
							verifyPhaseArtifacts,
						);
					}
					return result;
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_confirm_gate
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_confirm_gate",
			label: "TFF Confirm Gate",
			description:
				"Confirm a discuss-phase gate after user approval. Gates: 'depth_verified' (unlocks tff_write_spec) and 'tier_confirmed' (unlocks tff_classify). Only call after the user has explicitly confirmed.",
			promptGuidelines: [
				"Call with gate='depth_verified' after user confirms they're ready to write the spec",
				"Call with gate='tier_confirmed' after user confirms the proposed tier classification",
				"Do NOT call without explicit user confirmation",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				gate: StringEnum(["depth_verified", "tier_confirmed"], {
					description: "The gate to unlock: 'depth_verified' or 'tier_confirmed'",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const gate = DISCUSS_GATES.find((g) => g === params.gate);
					if (!gate) {
						return {
							content: [{ type: "text", text: `Invalid gate: ${params.gate}` }],
							details: { gate: params.gate },
							isError: true,
						};
					}
					unlockGate(slice.id, gate);
					const gateLabel =
						params.gate === "depth_verified"
							? "Depth verified — tff_write_spec is now unlocked."
							: "Tier confirmed — tff_classify is now unlocked.";
					return {
						content: [{ type: "text", text: gateLabel }],
						details: { sliceId: slice.id, gate: params.gate },
					};
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_create_project
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_add_remote
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_create_slice
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_spec
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_spec",
			label: "TFF Write Spec",
			description:
				"Write the SPEC.md artifact for a slice. During interactive discuss, requires depth verification gate to be unlocked first via tff_confirm_gate. IMPORTANT: After this tool returns successfully, STOP. Do not call any plannotator_* tools — TFF handles spec review automatically. If this tool returns an error with feedback, the user rejected the spec; revise and call this tool again.",
			promptSnippet:
				"Call tff_confirm_gate('depth_verified') before calling tff_write_spec. The system enforces this. After tff_write_spec succeeds, STOP — do not call plannotator tools. TFF handles review automatically.",
			promptGuidelines: [
				"Requires depth_verified gate — call tff_confirm_gate('depth_verified') first",
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
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"discuss",
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_requirements
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_requirements",
			label: "TFF Write Requirements",
			description:
				"Write the REQUIREMENTS.md artifact for a slice. Used during the discuss phase alongside SPEC.md. IMPORTANT: After this tool returns successfully, STOP. Do not call any plannotator_* tools — TFF handles requirements review automatically. If this tool returns an error with feedback, the user rejected the requirements; revise and call this tool again.",
			promptGuidelines: [
				"Write REQUIREMENTS.md with R-IDs, classes, acceptance conditions, and verification instructions",
				"Used during the discuss phase after writing SPEC.md",
				"IMPORTANT: Do not call plannotator tools after this tool returns. Review is automatic.",
				"If tool returns error with feedback, user rejected requirements; revise and retry.",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the requirements",
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
					const writeResult = handleWriteRequirements(
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
										text: `REQUIREMENTS.md review rejected in plannotator.\nFeedback: ${review.feedback ?? "(none)"}\nAddress the feedback and call tff_write_requirements again.`,
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
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"discuss",
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_research
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_plan
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_plan",
			label: "TFF Write Plan",
			description:
				"Write the PLAN.md artifact for a slice and register tasks with dependency graph. THIS IS THE ONLY TOOL THAT MARKS THE PLAN PHASE COMPLETE — phase_complete fires here. After this tool returns successfully, STOP. Do not call any plannotator_* tools — TFF handles plan review automatically via event bus. If this tool returns an error with feedback, the user rejected the plan; revise and call this tool again.",
			promptSnippet:
				"The plan phase is not complete until tff_write_plan returns successfully. Writing PLAN.md via Write/Edit will NOT persist tasks — the database needs structured task entries via this tool.",
			promptGuidelines: [
				"Call this tool to persist PLAN.md AND structured tasks — not Write/Edit",
				"A successful call is the sole phase_complete signal for plan",
				"tasks array must not be empty — if you cannot decompose, ask the user via tff_ask_user",
				"Plannotator review opens automatically after writing",
				"IMPORTANT: Do not call plannotator tools after this tool returns. Review is automatic.",
				"If tool returns error with feedback, user rejected plan; revise and retry.",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "The markdown content of the plan",
				}),
				tasks: Type.Array(
					Type.Object({
						title: Type.String({ description: "Short task title" }),
						description: Type.String({ description: "What this task involves" }),
						dependsOn: Type.Optional(
							Type.Array(Type.Number(), {
								description:
									"1-based indices of tasks this depends on (e.g. [1, 3] means depends on task 1 and task 3)",
							}),
						),
						files: Type.Optional(
							Type.Array(Type.String(), {
								description: "Files this task will touch",
							}),
						),
					}),
					{ description: "List of tasks that make up the implementation plan" },
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
					const writeResult = handleWritePlan(
						database,
						root,
						slice.id,
						params.content,
						params.tasks,
						ctx.settings ?? DEFAULT_SETTINGS,
					);
					if (!writeResult.isError) {
						const review = await requestReview(
							pi,
							String(writeResult.details.path),
							params.content,
							"plan",
						);
						if (!review.approved) {
							return {
								content: [
									{
										type: "text",
										text: `PLAN.md review rejected in plannotator.\nFeedback: ${review.feedback ?? "(none)"}\nAddress the feedback and call tff_write_plan again with an updated tasks array.`,
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
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"plan",
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_ask_user — curated multiple-choice questions for the user
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_ask_user",
			label: "TFF Ask User",
			description:
				"Present 1+ curated multiple-choice questions to the user. Each question must have 2-3 bounded options (single-select) or 2+ (multi-select). Use this INSTEAD of free-form questions to prevent agent-invented options.",
			promptGuidelines: [
				"Use for any user decision that has a discrete set of valid answers",
				"Single-select questions: 2-3 options; 'None of the above' is auto-injected",
				"Multi-select: set allowMultiple=true; any number of options",
				"Headers must be ≤12 characters (TUI label)",
				"Do not paraphrase user input into your own options — if the user gave a free-form answer, reflect it back literally",
			],
			parameters: Type.Object({
				questions: Type.Array(
					Type.Object({
						id: Type.String({
							description: "Stable snake_case id for mapping the user's answer back",
						}),
						header: Type.String({
							description: "Short header shown in the UI (≤12 chars)",
						}),
						question: Type.String({
							description: "Single-sentence prompt shown to the user",
						}),
						options: Type.Array(
							Type.Object({
								label: Type.String({ description: "1-5 word user-facing label" }),
								description: Type.String({
									description: "One short sentence explaining the impact/tradeoff",
								}),
							}),
							{
								description:
									"2-3 mutually-exclusive options for single-select, or 2+ for multi-select",
							},
						),
						allowMultiple: Type.Optional(
							Type.Boolean({
								description: "Allow the user to select multiple options. Default false.",
							}),
						),
					}),
					{ description: "One or more questions to ask the user" },
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					return handleAskUser(params.questions as AskUserQuestion[]);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: {},
						isError: true,
					};
				}
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_verification — persists VERIFICATION.md and marks verify complete
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_verification",
			label: "TFF Write Verification",
			description:
				"Write VERIFICATION.md for a slice. THIS IS THE ONLY TOOL THAT MARKS THE VERIFY PHASE COMPLETE — phase_complete fires here. Use it to persist AC PASS/FAIL results and test output after the verify phase.",
			promptSnippet:
				"The verify phase is not complete until tff_write_verification returns successfully. Writing the file via Write/Edit will not mark the phase complete.",
			promptGuidelines: [
				"Include an AC checklist with [x]/[ ] markers so the ship pre-flight check can scan it",
				"Include the test command run and its output summary (pass/fail counts)",
				"On failures: mark the AC [ ] and describe what broke + which task(s) to re-execute",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "Markdown content of VERIFICATION.md",
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
					const writeResult = handleWriteVerification(database, root, slice.id, params.content);
					if (!writeResult.isError) {
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"verify",
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_write_review — persists REVIEW.md and marks review complete
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_write_review",
			label: "TFF Write Review",
			description:
				"Write REVIEW.md for a slice AND submit the verdict. THIS IS THE ONLY TOOL THAT MARKS THE REVIEW PHASE COMPLETE — phase_complete fires here. On verdict='denied' the slice is routed back to execute with tasks reset to open.",
			promptSnippet:
				"The review phase is not complete until tff_write_review returns successfully. Pass verdict='approved' to unlock ship, or verdict='denied' to loop back to execute.",
			promptGuidelines: [
				"content must include findings list with file:line references",
				"Use verdict='approved' only when there are no blocking issues",
				"Use verdict='denied' when any finding blocks shipping; describe what task(s) need rework",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "Markdown content of REVIEW.md (summary + findings + tasksToRework)",
				}),
				verdict: StringEnum(["approved", "denied"] as const, {
					description:
						"approved = no blocking issues, unlocks ship. denied = loop back to execute with tasks reset.",
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
					const writeResult = handleWriteReview(
						database,
						root,
						slice.id,
						params.content,
						params.verdict as ReviewVerdict,
					);
					if (!writeResult.isError && params.verdict === "approved") {
						emitPhaseCompleteIfArtifactsReady(
							pi,
							database,
							root,
							slice,
							"review",
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

	// -------------------------------------------------------------------------
	// AI Tool: tff_ship_merged — user attests the PR was merged on GitHub
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_ship_merged",
			label: "TFF Ship: PR Merged",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the slice PR was merged on GitHub. Cleans up the worktree, deletes the slice branch, pulls the milestone branch, and closes the slice. Do NOT call this without explicit user confirmation.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const database = getDb(ctx);
				const root = ctx.projectRoot;
				if (!root) {
					return {
						content: [{ type: "text", text: "Error: No project root." }],
						details: {},
						isError: true,
					};
				}
				const slice = resolveSlice(database, params.sliceLabel);
				if (!slice) {
					return {
						content: [{ type: "text", text: `Slice not found: ${params.sliceLabel}` }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				const result = handleShipMerged(pi, database, root, slice.id);
				return {
					content: [{ type: "text", text: result.message }],
					details: { sliceLabel: params.sliceLabel },
					isError: !result.success,
				};
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_ship_changes — user reports reviewer requested changes
	// -------------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "tff_ship_changes",
			label: "TFF Ship: Changes Requested",
			description:
				"Call AFTER the user confirms (via tff_ask_user) that the PR needs changes AND provides the reviewer feedback text. Flips the slice back to execute with the feedback attached. Pass the reviewer feedback verbatim — do NOT summarize.",
			parameters: Type.Object({
				sliceLabel: Type.String({
					description: "Slice label (e.g., M01-S01) or slice id",
				}),
				feedback: Type.String({
					description: "Reviewer's change request text, verbatim from the user's message",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const database = getDb(ctx);
				const slice = resolveSlice(database, params.sliceLabel);
				if (!slice) {
					return {
						content: [{ type: "text", text: `Slice not found: ${params.sliceLabel}` }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				const result = handleShipChanges(pi, database, slice.id, params.feedback);
				if (!result.success) {
					return {
						content: [{ type: "text", text: result.message }],
						details: { sliceLabel: params.sliceLabel },
						isError: true,
					};
				}
				// Slice is now `executing` with tasks reset. Tell the agent to
				// run /tff execute to re-enter with the feedback. We don't
				// auto-invoke runHeavyPhase here because this handler runs
				// inside the agent turn; the user will drive the next step
				// via /tff execute (or agent-suggested `/tff next`).
				return {
					content: [
						{
							type: "text",
							text: `${result.message}\n\nNext: tell the user to run \`/tff execute ${params.sliceLabel}\` (or \`/tff next\`) to apply the changes.`,
						},
					],
					details: { sliceLabel: params.sliceLabel, feedback: params.feedback },
				};
			},
		}),
	);

	// -------------------------------------------------------------------------
	// AI Tool: tff_checkpoint
	// -------------------------------------------------------------------------
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
