import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, findSliceByLabel, getDb } from "../common/context.js";
import { getMilestone, getSlice } from "../common/db.js";
import type { PhaseContext } from "../common/phase.js";
import { DEFAULT_SETTINGS } from "../common/settings.js";
import { type ValidateResult, sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";
import { phaseModules } from "../phases/index.js";
import { assertPhasePreconditions } from "./phase-guard.js";
import { runHeavyPhase } from "./run-heavy-phase.js";

export function validateExecute(
	db: Database.Database,
	sliceId: string,
	projectRoot: string | null = null,
): ValidateResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return { valid: false, error: `Slice not found: ${sliceId}` };
	}
	if (slice.status !== "planning" && slice.status !== "executing") {
		return {
			valid: false,
			error: `Cannot execute: slice is in '${slice.status}' status (expected 'planning' or 'executing')`,
		};
	}
	return assertPhasePreconditions(db, projectRoot, sliceId, "execute");
}

export async function runExecute(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const database = getDb(ctx);
	const root = ctx.projectRoot;
	if (!root) return;
	const label = args[0] ?? "";
	const slice = label
		? (findSliceByLabel(database, label) ?? getSlice(database, label))
		: findActiveSlice(database);
	if (!slice) {
		const msg = label ? `Slice not found: ${label}` : "No active slice found.";
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, "error");
		return;
	}
	const validation = validateExecute(database, slice.id, ctx.projectRoot);
	if (!validation.valid) {
		if (uiCtx?.hasUI) uiCtx.ui.notify(validation.error ?? "Unknown error", "error");
		return;
	}
	const milestone = getMilestone(database, slice.milestoneId);
	if (!milestone) return;
	const currentSettings = ctx.settings ?? DEFAULT_SETTINGS;
	const mod = phaseModules.execute;
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
			`Starting execute phase for ${sliceLabel(milestone.number, slice.number)}...`,
			"info",
		);
	await runHeavyPhase(ctx, "execute", mod, phaseCtx);
}
