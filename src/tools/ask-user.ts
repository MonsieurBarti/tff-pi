import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TffContext } from "../common/context.js";

export interface AskUserOption {
	label: string;
	description: string;
}

export interface AskUserQuestion {
	id: string;
	header: string;
	question: string;
	options: AskUserOption[];
	allowMultiple?: boolean;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS_SINGLE = 3;
const MAX_HEADER_LEN = 12;

/**
 * Validates and formats a curated-choice question to present to the user.
 * Mirrors GSD-2's `ask_user_questions` pattern: agents cannot hallucinate
 * extra choices because the schema enforces 2-3 bounded options per question
 * (single-select) and mutually exclusive labels.
 *
 * For single-select questions, an extra "None of the above" option is
 * auto-injected so the user always has an escape hatch.
 */
export function handleAskUser(questions: AskUserQuestion[]): ToolResult {
	if (questions.length === 0) {
		return {
			content: [{ type: "text", text: "tff_ask_user requires at least one question." }],
			details: {},
			isError: true,
		};
	}

	const seenIds = new Set<string>();
	for (const q of questions) {
		if (seenIds.has(q.id)) {
			return {
				content: [{ type: "text", text: `Duplicate question id: ${q.id}` }],
				details: { id: q.id },
				isError: true,
			};
		}
		seenIds.add(q.id);

		if (q.header.length > MAX_HEADER_LEN) {
			return {
				content: [
					{
						type: "text",
						text: `Header '${q.header}' exceeds ${MAX_HEADER_LEN} characters.`,
					},
				],
				details: { id: q.id, header: q.header },
				isError: true,
			};
		}

		if (q.options.length < MIN_OPTIONS) {
			return {
				content: [
					{
						type: "text",
						text: `Question '${q.id}' has ${q.options.length} option(s); minimum is ${MIN_OPTIONS}.`,
					},
				],
				details: { id: q.id, optionCount: q.options.length },
				isError: true,
			};
		}

		if (!q.allowMultiple && q.options.length > MAX_OPTIONS_SINGLE) {
			return {
				content: [
					{
						type: "text",
						text: `Question '${q.id}' has ${q.options.length} options; single-select allows at most ${MAX_OPTIONS_SINGLE}. Split the question or set allowMultiple=true.`,
					},
				],
				details: { id: q.id, optionCount: q.options.length },
				isError: true,
			};
		}

		const seenLabels = new Set<string>();
		for (const opt of q.options) {
			const norm = opt.label.trim().toLowerCase();
			if (seenLabels.has(norm)) {
				return {
					content: [
						{
							type: "text",
							text: `Question '${q.id}' has duplicate option label: '${opt.label}'.`,
						},
					],
					details: { id: q.id, label: opt.label },
					isError: true,
				};
			}
			seenLabels.add(norm);
		}
	}

	const sections: string[] = [];
	// Agent-directed stop instruction. Without this the agent tends to keep
	// calling tools (confirm_gate, write_spec, next tff_ask_user) immediately
	// after displaying a question, bypassing the user entirely. PI cannot
	// pause the agent loop, so the instruction has to live in the tool
	// result the agent reads next.
	sections.push(
		"[AGENT-STOP] You have just shown the user a question. End your turn NOW — emit no further tool calls, no summary, no restatement. Wait for the user's next message (their numeric reply). Only after receiving that reply may you proceed.",
	);
	sections.push("");
	for (const q of questions) {
		const finalOptions = q.allowMultiple
			? q.options
			: [...q.options, { label: "None of the above", description: "Request a different option." }];
		const mode = q.allowMultiple ? "choose any that apply" : "choose one";
		sections.push(`## ${q.header} — ${mode}`);
		sections.push("");
		sections.push(q.question);
		sections.push("");
		for (let i = 0; i < finalOptions.length; i++) {
			const opt = finalOptions[i];
			if (!opt) continue;
			// Label and description on separate lines so narrow terminals and
			// raw-text renderers both keep them readable. No bold markers —
			// they render as literal `**` in plain-text TUI contexts.
			sections.push(`  ${i + 1}) ${opt.label}`);
			sections.push(`     ${opt.description}`);
		}
		sections.push("");
		sections.push(`Reply with the option number(s) for "${q.id}".`);
		sections.push("");
	}

	return {
		content: [{ type: "text", text: sections.join("\n") }],
		details: {
			questionCount: questions.length,
			questionIds: questions.map((q) => q.id),
		},
	};
}

export function register(pi: ExtensionAPI, _ctx: TffContext): void {
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
}
