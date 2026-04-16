import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";

export async function runHelp(
	pi: ExtensionAPI,
	_ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	_args: string[],
): Promise<void> {
	pi.sendUserMessage(
		"Here are the available TFF commands:\n\n" +
			"**Project setup:**\n" +
			"- `/tff new [name]` — Start a new project (AI-assisted brainstorm)\n" +
			"- `/tff new-milestone [name]` — Create a new milestone\n\n" +
			"**Slice workflow:**\n" +
			"- `/tff discuss [sliceId]` — Run the discuss phase on a slice\n" +
			"- `/tff research [sliceId]` — Run the research phase on a slice\n" +
			"- `/tff plan [sliceId]` — Run the plan phase on a slice\n\n" +
			"Phases end with a printed `→ Next: /tff <phase> M##-S##` hint. Type what it shows to advance.\n\n" +
			"**Monitoring:**\n" +
			"- `/tff status` — Show current project status\n" +
			"- `/tff progress` — Show detailed progress table\n" +
			"- `/tff logs [M01-S01] [--json]` — Show event timeline for a slice\n" +
			"- `/tff health` — Quick database health check\n" +
			"- `/tff settings` — Show current settings\n" +
			"- `/tff help` — Show this help\n\n" +
			"**Execution:**\n" +
			"- `/tff execute [sliceId]` — Run the execute phase (wave-based task dispatch)\n" +
			"- `/tff verify [sliceId]` — Run verification (AC check + tests)\n" +
			"- `/tff review [sliceId]` — Run code + security review on the slice diff\n" +
			"- `/tff ship [sliceId]` — Open the slice PR and run CI\n" +
			"- `/tff ship-merged [sliceId]` — You merged the PR: cleanup worktree + close slice\n" +
			"- `/tff ship-changes [sliceId] <feedback>` — Reviewer requested changes: reopen for fixes\n" +
			"- `/tff complete-milestone [M01]` — Create milestone PR after all slices ship",
	);
}
