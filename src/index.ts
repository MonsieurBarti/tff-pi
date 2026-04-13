import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { COMMANDS } from "./commands/registry.js";
import { createTffContext } from "./common/context.js";
import { VALID_SUBCOMMANDS, isValidSubcommand, parseSubcommand } from "./common/router.js";
import { registerLifecycleHooks } from "./lifecycle.js";
import { registerAllTools } from "./tools/index.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function tffExtension(pi: ExtensionAPI): void {
	const ctx = createTffContext();

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
	// AI tool registrations (17 tools). See src/tools/index.ts.
	// -------------------------------------------------------------------------
	registerAllTools(pi, ctx);
}
