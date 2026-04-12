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

	const sections: string[] = ["## Please choose"];
	for (const q of questions) {
		const finalOptions = q.allowMultiple
			? q.options
			: [...q.options, { label: "None of the above", description: "Request a different option." }];
		const mode = q.allowMultiple ? "choose any that apply" : "choose one";
		sections.push(`\n### ${q.header} (${mode})`);
		sections.push(`${q.question}\n`);
		for (let i = 0; i < finalOptions.length; i++) {
			const opt = finalOptions[i];
			if (!opt) continue;
			sections.push(`${i + 1}. **${opt.label}** — ${opt.description}`);
		}
		sections.push(`\n_(Reply with the option number(s) for \`${q.id}\`.)_`);
	}

	return {
		content: [{ type: "text", text: sections.join("\n") }],
		details: {
			questionCount: questions.length,
			questionIds: questions.map((q) => q.id),
		},
	};
}
