import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, requireProject } from "../common/context.js";
import { getMilestone, getSlice } from "../common/db.js";
import type { PhaseContext } from "../common/phase.js";
import type { Phase } from "../common/types.js";
import { determineNextPhase, findActiveSlice } from "../orchestrator.js";
import { phaseModules } from "../phases/index.js";
import { assertPhasePreconditions } from "./phase-guard.js";
import { runHeavyPhase } from "./run-heavy-phase.js";

export interface NextValidation {
	valid: boolean;
	phase?: Phase;
	sliceId?: string;
	error?: string;
}

export function validateNext(
	db: Database.Database,
	projectRoot: string | null = null,
): NextValidation {
	const slice = findActiveSlice(db);
	if (!slice) return { valid: false, error: "No active slice found" };
	const phase = determineNextPhase(slice.status, slice.tier);
	if (!phase) return { valid: false, error: `No next phase available from '${slice.status}'` };
	const guard = assertPhasePreconditions(db, projectRoot, slice.id, phase);
	if (!guard.valid) return { valid: false, error: guard.error ?? "Previous phase incomplete" };
	return { valid: true, phase, sliceId: slice.id };
}

export async function runNext(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	_args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root, settings: currentSettings } = project;
	const validation = validateNext(database, root);
	if (!validation.valid) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(validation.error ?? "Unknown error", "error");
		return;
	}
	const sliceId = validation.sliceId;
	const phase = validation.phase;
	if (!sliceId || !phase) return;
	const slice = getSlice(database, sliceId);
	if (!slice) return;
	const milestone = getMilestone(database, slice.milestoneId);
	if (!milestone) return;
	const mod = phaseModules[phase];
	const phaseCtx: PhaseContext = {
		pi,
		db: database,
		root,
		slice,
		milestoneNumber: milestone.number,
		settings: currentSettings,
		fffBridge: ctx.fffBridge,
	};
	await runHeavyPhase(ctx, phase, mod, phaseCtx);
}
