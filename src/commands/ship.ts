import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { type PhaseContext, runPhaseWithFreshContext } from "../common/phase.js";
import { type ValidateResult, sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";
import { phaseModules } from "../phases/index.js";
import { assertPhasePreconditions } from "./phase-guard.js";
import { runHeavyPhase } from "./run-heavy-phase.js";

export function validateShip(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "reviewing" && slice.status !== "shipping") {
		return {
			valid: false,
			error: `Cannot ship: slice is in '${slice.status}' status (expected 'reviewing' or 'shipping')`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "ship");
}

export async function runShip(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root, settings: currentSettings } = project;
	const label = args[0] ?? "";
	const slice = label ? resolveSlice(database, label) : findActiveSlice(database);
	if (!slice) {
		const msg = label ? `Slice not found: ${label}` : "No active slice found.";
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, "error");
		return;
	}
	const validation = validateShip(database, slice.id, root);
	if (!validation.valid) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(validation.error ?? "Unknown error", "error");
		return;
	}
	const milestone = getMilestone(database, slice.milestoneId);
	if (!milestone) return;
	const mod = phaseModules.ship;
	const phaseCtx: PhaseContext = {
		pi,
		db: database,
		root,
		slice,
		milestoneNumber: milestone.number,
		settings: currentSettings,
		fffBridge: ctx.fffBridge,
	};
	if (uiCtx?.hasUI)
		uiCtx.ui.notify(
			`Starting ship phase for ${sliceLabel(milestone.number, slice.number)}...`,
			"info",
		);
	const result = await runPhaseWithFreshContext({
		phaseModule: mod,
		phaseCtx,
		cmdCtx: ctx.cmdCtx,
		phase: "ship",
	});
	if (result.success) {
		if (uiCtx?.hasUI) uiCtx.ui.notify("Ship phase complete.", "info");
	} else if (result.retry && result.feedback) {
		// PR has review comments — re-enter execute with feedback
		if (uiCtx?.hasUI)
			uiCtx.ui.notify("PR has review comments. Re-entering execute phase for fixes.", "info");
		const executeMod = phaseModules.execute;
		const freshSlice = getSlice(database, slice.id);
		if (freshSlice) {
			const execCtx: PhaseContext = {
				pi,
				db: database,
				root,
				slice: freshSlice,
				milestoneNumber: milestone.number,
				settings: currentSettings,
				feedback: result.feedback,
			};
			await runHeavyPhase(ctx, "execute", executeMod, execCtx);
		}
	} else {
		if (uiCtx?.hasUI)
			uiCtx.ui.notify(`Ship phase failed: ${result.error ?? "unknown error"}`, "error");
	}
}
