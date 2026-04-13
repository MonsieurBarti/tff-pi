import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import type { PhaseContext } from "../common/phase.js";
import { type ValidateResult, sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";
import { phaseModules } from "../phases/index.js";
import { assertPhasePreconditions } from "./phase-guard.js";
import { runHeavyPhase } from "./run-heavy-phase.js";

export function validateDiscuss(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "created" && slice.status !== "discussing") {
		return {
			valid: false,
			error: `Cannot start discuss: slice is in '${slice.status}' status (expected 'created' or 'discussing')`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "discuss");
}

export async function runDiscuss(
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
	const validation = validateDiscuss(database, slice.id, root);
	if (!validation.valid) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(validation.error ?? "Unknown error", "error");
		return;
	}
	const milestone = getMilestone(database, slice.milestoneId);
	if (!milestone) return;
	const mod = phaseModules.discuss;
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
			`Starting discuss phase for ${sliceLabel(milestone.number, slice.number)}...`,
			"info",
		);
	await runHeavyPhase(ctx, "discuss", mod, phaseCtx);
}
