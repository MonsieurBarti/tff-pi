import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { getMilestone } from "./db.js";
import { makeBaseEvent } from "./events.js";
import { type Phase, type Slice, sliceLabel } from "./types.js";

/**
 * After a writer tool (tff_write_plan, tff_write_spec, ...) succeeds,
 * check whether the target phase's artifacts are now all present. If so,
 * emit `phase_complete` so phase_run.status is accurately marked 'completed'.
 *
 * Mirrors GSD-2's pattern of deriving phase completion from on-disk artifacts
 * rather than trusting the LLM to self-report.
 *
 * We take `verifyPhaseArtifacts` as a parameter to avoid a circular import
 * with orchestrator.ts (which imports common/* modules).
 */
export function emitPhaseCompleteIfArtifactsReady(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	slice: Slice,
	phase: Phase,
	verifyPhaseArtifacts: (
		db: Database.Database,
		root: string,
		slice: Slice,
		milestoneNumber: number,
		phase: Phase,
	) => { ok: boolean; missing: string[] },
): void {
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return;
	const check = verifyPhaseArtifacts(db, root, slice, milestone.number, phase);
	if (!check.ok) return;
	const sLabel = sliceLabel(milestone.number, slice.number);
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_complete",
		phase,
	});
}
