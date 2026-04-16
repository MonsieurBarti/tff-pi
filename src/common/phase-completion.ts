import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { countOpenSlicesInMilestone, getLatestPhaseRun, getMilestone } from "./db.js";
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
/**
 * Implicit-completion helper — called at the top of each phase's `run()`.
 *
 * When phase X starts, the predecessor phase Y must have been done
 * (its artifacts are a precondition to enter X, checked separately by
 * the phase guard). But phases without a dedicated writer tool (execute)
 * or phases where the writer tool is optional (research on non-SSS tier)
 * never emit `phase_complete` for Y, leaving `phase_run.Y` forever
 * `'started'` and tripping `/tff doctor` stall detection.
 *
 * This helper scans `phase_run` for the predecessor of `currentPhase`. If
 * the most-recent run is still `'started'` AND the predecessor's artifacts
 * are present (per `verifyPhaseArtifacts`), emit `phase_complete` for it
 * so the DB reflects truth. Safe to call multiple times — the event-logger
 * no-ops if the run is already completed.
 *
 * `predecessorPhase` is injected to avoid a circular import.
 */
export function closePredecessorIfReady(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	slice: Slice,
	currentPhase: Phase,
	predecessorPhase: (p: Phase, tier?: Slice["tier"]) => Phase | null,
	verifyPhaseArtifacts: (
		db: Database.Database,
		root: string,
		slice: Slice,
		milestoneNumber: number,
		phase: Phase,
	) => { ok: boolean; missing: string[] },
): void {
	const predecessor = predecessorPhase(currentPhase, slice.tier);
	if (!predecessor) return;

	const priorRun = getLatestPhaseRun(db, slice.id, predecessor);
	if (!priorRun || priorRun.status !== "started") return;

	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return;

	const check = verifyPhaseArtifacts(db, root, slice, milestone.number, predecessor);
	if (!check.ok) return;

	const sLabel = sliceLabel(milestone.number, slice.number);
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_complete",
		phase: predecessor,
	});
}

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

// Mirrors orchestrator.ts:determineNextPhase — kept separate to avoid a
// circular import (phase-completion.ts must not import from orchestrator.ts).
// If determineNextPhase changes, this function must change in lockstep.
function nextPhaseFor(
	status: Slice["status"],
	tier: Slice["tier"] | null | undefined,
): Phase | null {
	switch (status) {
		case "created":
			return "discuss";
		case "discussing":
			return tier === "S" ? "plan" : "research";
		case "researching":
			return "plan";
		case "planning":
			return "execute";
		case "executing":
			return "verify";
		case "verifying":
			return "review";
		case "reviewing":
			return "ship";
		default:
			return null;
	}
}

export function computeNextHint(
	db: Database.Database,
	slice: Slice,
	milestoneNumber: number,
): string | null {
	const nextPhase = nextPhaseFor(slice.status, slice.tier);
	const label = sliceLabel(milestoneNumber, slice.number);
	if (nextPhase) {
		return `→ Next: /tff ${nextPhase} ${label}`;
	}
	const openCount = countOpenSlicesInMilestone(db, slice.milestoneId);
	if (openCount > 0) {
		return "→ Next: /tff new";
	}
	return "→ Next: /tff complete-milestone";
}
