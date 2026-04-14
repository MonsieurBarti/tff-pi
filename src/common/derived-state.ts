import type Database from "better-sqlite3";
import { readArtifact } from "./artifacts.js";
import { getMilestone, getSlice } from "./db.js";
import {
	PIPELINE_PHASE_ORDER,
	type Phase,
	SIDE_CHANNEL_PHASES,
	SLICE_STATUSES,
	type Slice,
	type SliceStatus,
	type Tier,
	milestoneLabel,
	sliceLabel,
} from "./types.js";

// Rollback targets reflect SLICE_TRANSITIONS (state-machine.ts:3): only verify,
// review, and ship have backward transitions today (all to executing). For
// phases without a defined rollback, return the phase's own in-progress status
// so the agent can retry it.

function nextPhaseFor(current: Phase, tier: Tier | null): Phase | null {
	if (SIDE_CHANNEL_PHASES.includes(current)) return null; // side channel, not on the pipeline
	if (current === "discuss") return tier === "S" ? "plan" : "research";
	const idx = PIPELINE_PHASE_ORDER.indexOf(current);
	if (idx < 0 || idx === PIPELINE_PHASE_ORDER.length - 1) return null;
	return PIPELINE_PHASE_ORDER[idx + 1] ?? null;
}

function nextPhaseArtifactsReady(
	root: string,
	slice: Slice,
	milestoneNumber: number,
	nextPhase: Phase,
): boolean {
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);
	const base = `milestones/${mLabel}/slices/${sLabel}`;
	const need = (n: string) => readArtifact(root, `${base}/${n}`) !== null;
	const needMilestoneReq = () =>
		readArtifact(root, `milestones/${mLabel}/REQUIREMENTS.md`) !== null;

	switch (nextPhase) {
		case "research":
			return need("SPEC.md") && (need("REQUIREMENTS.md") || needMilestoneReq()) && !!slice.tier;
		case "plan":
			if (slice.tier === "S") {
				return need("SPEC.md") && (need("REQUIREMENTS.md") || needMilestoneReq()) && !!slice.tier;
			}
			return need("SPEC.md") && (slice.tier === "SSS" ? need("RESEARCH.md") : true);
		case "execute":
			return need("PLAN.md");
		case "verify":
			// Execute produces no dedicated artifact — the evidence that execute ran
			// lives in phase_run + git changes, not a file. We use PLAN.md as the
			// readiness signal because it is the precondition for BOTH execute and
			// verify, and rule 2 (in-flight) covers the "execute actively running"
			// case. This is not a copy-paste of the execute case.
			return need("PLAN.md");
		case "review":
			return need("VERIFICATION.md");
		case "ship":
			return need("REVIEW.md");
		default:
			return false;
	}
}

const ROLLBACK_TARGET: Record<Phase, SliceStatus | null> = {
	discuss: "discussing",
	research: "researching",
	plan: "planning",
	execute: "executing",
	verify: "executing",
	review: "executing",
	ship: "executing",
	"ship-fix": null,
};

const PHASE_TO_IN_PROGRESS_STATUS: Record<Phase, SliceStatus | null> = {
	discuss: "discussing",
	research: "researching",
	plan: "planning",
	execute: "executing",
	verify: "verifying",
	review: "reviewing",
	ship: "shipping",
	"ship-fix": null,
};

interface LatestPhaseRunRow {
	phase: string;
	status: string;
}

function latestNonIgnoredPhaseRun(
	db: Database.Database,
	sliceId: string,
): LatestPhaseRunRow | null {
	const placeholders = SIDE_CHANNEL_PHASES.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT phase, status FROM phase_run
       WHERE slice_id = ?
         AND phase NOT IN (${placeholders})
         AND status != 'abandoned'
       ORDER BY rowid DESC LIMIT 1`,
		)
		.get(sliceId, ...SIDE_CHANNEL_PHASES) as LatestPhaseRunRow | undefined;
	return row ?? null;
}

export function computeSliceStatus(
	db: Database.Database,
	root: string,
	sliceId: string,
): SliceStatus {
	const slice = getSlice(db, sliceId);
	if (!slice) return "created";

	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) return "created";

	const mLabel = milestoneLabel(milestone.number);
	const sLabel = sliceLabel(milestone.number, slice.number);
	const base = `milestones/${mLabel}/slices/${sLabel}`;

	// Rule 1: closed — ship completed + pr_url set
	const shipCompleted = db
		.prepare(
			`SELECT 1 FROM phase_run
     WHERE slice_id = ? AND phase = 'ship' AND status = 'completed'
     LIMIT 1`,
		)
		.get(sliceId) as { 1: number } | undefined;
	if (shipCompleted && slice.prUrl) return "closed";

	const latest = latestNonIgnoredPhaseRun(db, sliceId);

	// Rule 2: in-flight phase
	if (latest && (latest.status === "started" || latest.status === "retried")) {
		const mapped = PHASE_TO_IN_PROGRESS_STATUS[latest.phase as Phase];
		if (mapped) return mapped;
	}

	// Rule 3: rolled back — latest phase failed, return rollback target
	if (latest && latest.status === "failed") {
		const target = ROLLBACK_TARGET[latest.phase as Phase];
		if (target) return target;
	}

	// Rule 4: completed-waiting — forward if next phase preconditions satisfied,
	// otherwise stay in current phase's in-progress state
	if (latest && latest.status === "completed") {
		const currentPhase = latest.phase as Phase;
		const nextPhase = nextPhaseFor(currentPhase, slice.tier);
		if (nextPhase && nextPhaseArtifactsReady(root, slice, milestone.number, nextPhase)) {
			const mapped = PHASE_TO_IN_PROGRESS_STATUS[nextPhase];
			if (mapped) return mapped;
		}
		const currentMapped = PHASE_TO_IN_PROGRESS_STATUS[currentPhase];
		if (currentMapped) return currentMapped;
	}

	// Rule 7: no phase_runs fallback
	const hasSpec = readArtifact(root, `${base}/SPEC.md`) !== null;
	const hasRequirements = readArtifact(root, `${base}/REQUIREMENTS.md`) !== null;
	if (hasSpec || hasRequirements) return "discussing";

	return "created";
}

export interface ReconcileResult {
	status: SliceStatus; // the (possibly unchanged) current status
	from: SliceStatus; // the value before reconcile
	changed: boolean;
}

export function reconcileSliceStatus(
	db: Database.Database,
	root: string,
	sliceId: string,
): ReconcileResult {
	const current = getSlice(db, sliceId);
	if (!current) throw new Error(`Slice not found: ${sliceId}`);
	const computed = computeSliceStatus(db, root, sliceId);
	const changed = computed !== current.status;
	if (changed) {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(computed, sliceId);
		// Event emission happens in caller contexts that hold an event bus
		// (event-logger for phase-driven writes, recover/migration for explicit
		// reconciles). Keeping derived-state free of bus dependencies preserves
		// testability as a pure DB+FS function.
	}
	return { status: computed, from: current.status, changed };
}

/**
 * Direct cache write that bypasses `computeSliceStatus`. Reserved for two
 * audited call sites: `/tff recover --skip` (user-confirmed manual advance)
 * and `complete-milestone` (PR-merged-out-of-band force-close). Every caller
 * emits a `tff:override` event on the bus for forensics.
 *
 * Terminal-status safety: setting status = "closed" via this function is
 * permanent in practice because every reconciler caller filters
 * `status != "closed"` before considering a slice — so rule 1's evidence
 * requirement (ship/completed + pr_url) cannot revert a closed override.
 * New reconciler call sites MUST preserve the `!= "closed"` filter.
 */
export function overrideSliceStatus(
	db: Database.Database,
	sliceId: string,
	status: SliceStatus,
	_reason: string, // kept for API documentation; event emission happens in callers
): void {
	const current = getSlice(db, sliceId);
	if (!current) throw new Error(`Slice not found: ${sliceId}`);
	if (!(SLICE_STATUSES as readonly string[]).includes(status)) {
		throw new Error(`Invalid status: ${status}`);
	}
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(status, sliceId);
}
