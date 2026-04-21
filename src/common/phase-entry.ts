import type Database from "better-sqlite3";
import { commitCommand } from "./commit.js";
import { getLatestPhaseRun } from "./db.js";
import { canTransitionSlice } from "./state-machine.js";
import type { Phase, Slice, SliceStatus } from "./types.js";

const PHASE_IN_PROGRESS_STATUS: Partial<Record<Phase, SliceStatus>> = {
	discuss: "discussing",
	research: "researching",
	plan: "planning",
	execute: "executing",
	verify: "verifying",
	review: "reviewing",
	ship: "shipping",
};

// Idempotently move a slice into <phase>ing and stamp a started phase_run.
//
// Three cases:
//   1. Slice already at target with a started phase_run → no-op.
//   2. Slice already at target but no started phase_run → emit "phase-start"
//      (covers derived-state.ts Rule 4 auto-promotion: prior phase's writer
//      tool completed → reconcileSliceStatus promoted slice.status forward
//      before this phase's prepare() ran, so no transition command was
//      emitted and no phase_run was inserted for the new phase).
//   3. Slice at a prior state that can legally transition to target → emit
//      "transition" (commits both slice.status update AND inserts phase_run).
//
// Side-channel phases (ship-fix) are a no-op — they share the shipping
// status and don't own a phase_run lifecycle.
export function ensurePhaseTransition(
	db: Database.Database,
	root: string,
	slice: Slice,
	phase: Phase,
): void {
	const target = PHASE_IN_PROGRESS_STATUS[phase];
	if (!target) return;

	if (slice.status === target) {
		const latest = getLatestPhaseRun(db, slice.id, phase);
		if (latest && latest.status === "started") return;
		commitCommand(db, root, "phase-start", {
			sliceId: slice.id,
			phase,
			startedAt: new Date().toISOString(),
		});
		return;
	}

	if (!canTransitionSlice(slice.status, target)) {
		throw new Error(
			`Cannot enter ${phase} phase: slice is in '${slice.status}' and the state machine does not allow '${slice.status}' → '${target}'.`,
		);
	}
	commitCommand(db, root, "transition", {
		sliceId: slice.id,
		from: slice.status,
		to: target,
		phase,
		startedAt: new Date().toISOString(),
	});
}
