// src/commands/registry.ts
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";
import type { Subcommand } from "../common/router.js";

export type CommandHandler = (
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
) => Promise<void>;

/**
 * Dispatch table for `/tff <subcommand>`. Populated by Tasks 9-14 as each
 * slash command case is moved out of index.ts into its own module.
 *
 * Invariant enforced by tests/unit/structural/commands.spec.ts:
 *   - Every entry in COMMANDS must be a valid Subcommand (weak direction).
 *   - Task 14 will add the strong direction: every Subcommand has an entry.
 */
export const COMMANDS: Map<Subcommand, CommandHandler> = new Map();
