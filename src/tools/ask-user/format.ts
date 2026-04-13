import type { RoundResult } from "./interview-ui.js";

export function formatForLLM(result: RoundResult): string {
	const ids = Object.keys(result.answers);
	if (ids.length === 0) return "User answers: (none)";

	const lines: string[] = ["User answers:"];
	for (const id of ids) {
		const { selected, notes } = result.answers[id] as {
			selected: string | string[];
			notes: string;
		};
		const label = Array.isArray(selected) ? selected.join(", ") : selected;
		lines.push(`- ${id}: ${label}`);
		if (notes && notes.trim().length > 0) {
			lines.push(`  Notes: ${notes}`);
		}
	}
	return lines.join("\n");
}
