import type Database from "better-sqlite3";
import { readArtifact } from "./artifacts.js";
import { getMilestone, getSlice } from "./db.js";
import { type Phase, type SliceStatus, milestoneLabel, sliceLabel } from "./types.js";

// Rollback targets reflect SLICE_TRANSITIONS (state-machine.ts:3): only verify,
// review, and ship have backward transitions today (all to executing). For
// phases without a defined rollback, return the phase's own in-progress status
// so the agent can retry it.
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
	const row = db
		.prepare(
			`SELECT phase, status FROM phase_run
       WHERE slice_id = ?
         AND phase != 'ship-fix'
         AND status != 'abandoned'
       ORDER BY rowid DESC LIMIT 1`,
		)
		.get(sliceId) as LatestPhaseRunRow | undefined;
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

	// Rule 7: no phase_runs fallback
	const hasSpec = readArtifact(root, `${base}/SPEC.md`) !== null;
	const hasRequirements = readArtifact(root, `${base}/REQUIREMENTS.md`) !== null;
	if (hasSpec || hasRequirements) return "discussing";

	return "created";
}
