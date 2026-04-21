import type Database from "better-sqlite3";
import { commitCommand } from "./commit.js";
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
// Prior to this helper, phase prepare() functions emitted phase_start events
// without committing the transition, leaving slices stuck in their prior status
// and tripping downstream preconditions. Side-channel phases (ship-fix) are
// no-ops — they share the shipping status and don't own phase_run lifecycle.
export function ensurePhaseTransition(
	db: Database.Database,
	root: string,
	slice: Slice,
	phase: Phase,
): void {
	const target = PHASE_IN_PROGRESS_STATUS[phase];
	if (!target) return;
	if (slice.status === target) return;
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
