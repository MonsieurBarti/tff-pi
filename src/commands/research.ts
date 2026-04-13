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

export function validateResearch(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "discussing" && slice.status !== "researching") {
		return {
			valid: false,
			error: `Cannot start research: slice is in '${slice.status}' status (expected 'discussing' or 'researching')`,
		};
	}
	if (slice.tier === "S") {
		return {
			valid: false,
			error: "Cannot research an S-tier slice — skip directly to plan",
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "research");
}

export async function runResearch(
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
	const validation = validateResearch(database, slice.id, root);
	if (!validation.valid) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(validation.error ?? "Unknown error", "error");
		return;
	}
	const milestone = getMilestone(database, slice.milestoneId);
	if (!milestone) return;
	const mod = phaseModules.research;
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
			`Starting research phase for ${sliceLabel(milestone.number, slice.number)}...`,
			"info",
		);
	await runHeavyPhase(ctx, "research", mod, phaseCtx);
}
