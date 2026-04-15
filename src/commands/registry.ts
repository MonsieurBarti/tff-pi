// src/commands/registry.ts
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";
import type { Subcommand } from "../common/router.js";
import { runBranchRename } from "./branch-rename.js";
import { runCompleteMilestoneChanges } from "./complete-milestone-changes.js";
import { runCompleteMilestoneMerged } from "./complete-milestone-merged.js";
import { runCompleteMilestone } from "./complete-milestone.js";
import { runDiscuss } from "./discuss.js";
import { runDoctor } from "./doctor.js";
import { runExecute } from "./execute.js";
import { runHealth } from "./health.js";
import { runHelp } from "./help.js";
import { runInit } from "./init.js";
import { runLogs } from "./logs.js";
import { runNewMilestone } from "./new-milestone.js";
import { runNew } from "./new.js";
import { runNext } from "./next.js";
import { runPlan } from "./plan.js";
import { runProgress } from "./progress.js";
import { runRecover } from "./recover.js";
import { runResearch } from "./research.js";
import { runSettings } from "./settings.js";
import { runShipChanges } from "./ship-changes.js";
import { runShipMerged } from "./ship-merged.js";
import { runShip } from "./ship.js";
import { runStateRename } from "./state-rename.js";
import { runStatus } from "./status.js";
import { runVerify } from "./verify.js";

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

COMMANDS.set("init", runInit);
COMMANDS.set("status", runStatus);
COMMANDS.set("progress", runProgress);
COMMANDS.set("logs", runLogs);
COMMANDS.set("health", runHealth);
COMMANDS.set("doctor", runDoctor);
COMMANDS.set("settings", runSettings);
COMMANDS.set("help", runHelp);
COMMANDS.set("new", runNew);
COMMANDS.set("new-milestone", runNewMilestone);
COMMANDS.set("recover", runRecover);
COMMANDS.set("complete-milestone", runCompleteMilestone);
COMMANDS.set("complete-milestone-merged", runCompleteMilestoneMerged);
COMMANDS.set("complete-milestone-changes", runCompleteMilestoneChanges);
COMMANDS.set("discuss", runDiscuss);
COMMANDS.set("research", runResearch);
COMMANDS.set("plan", runPlan);
COMMANDS.set("execute", runExecute);
COMMANDS.set("verify", runVerify);
COMMANDS.set("ship", runShip);
COMMANDS.set("ship-merged", runShipMerged);
COMMANDS.set("ship-changes", runShipChanges);
COMMANDS.set("next", runNext);

// Dispatch /tff state <sub>
const runStateSub: CommandHandler = async (pi, ctx, uiCtx, args) => {
	const sub = args[0];
	const rest = args.slice(1);
	if (sub === "rename") return runStateRename(pi, ctx, uiCtx, rest);
	pi.sendUserMessage(`Unknown /tff state subcommand: ${sub ?? "(none)"}. Try: rename`);
};
COMMANDS.set("state", runStateSub);

// Dispatch /tff branch <sub>
const runBranchSub: CommandHandler = async (pi, ctx, uiCtx, args) => {
	const sub = args[0];
	const rest = args.slice(1);
	if (sub === "rename") return runBranchRename(pi, ctx, uiCtx, rest);
	pi.sendUserMessage(`Unknown /tff branch subcommand: ${sub ?? "(none)"}. Try: rename`);
};
COMMANDS.set("branch", runBranchSub);
