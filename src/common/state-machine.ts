import type { MilestoneStatus, SliceStatus, Tier } from "./types.js";

export const SLICE_TRANSITIONS: Record<SliceStatus, SliceStatus[]> = {
	created: ["discussing"],
	discussing: ["researching", "planning"],
	researching: ["planning"],
	planning: ["executing"],
	executing: ["verifying"],
	verifying: ["reviewing", "executing"],
	reviewing: ["shipping", "executing"],
	shipping: ["closed", "executing"],
	closed: [],
};

export const MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
	created: ["in_progress"],
	in_progress: ["completing"],
	completing: ["closed"],
	closed: [],
};

export const HUMAN_GATES: SliceStatus[] = ["discussing", "planning", "shipping"];

export function canTransitionSlice(from: SliceStatus, to: SliceStatus): boolean {
	return SLICE_TRANSITIONS[from].includes(to);
}

export function nextSliceStatus(current: SliceStatus, tier?: Tier): SliceStatus | null {
	if (current === "closed") return null;
	if (current === "discussing" && tier === "S") return "planning";

	// NOTE: this is the SliceStatus ordering (includes 'created' and 'closed').
	// The Phase equivalent lives as PIPELINE_PHASE_ORDER in types.ts — keep both
	// in sync if the pipeline adds/removes phases.
	const forwardPath: SliceStatus[] = [
		"created",
		"discussing",
		"researching",
		"planning",
		"executing",
		"verifying",
		"reviewing",
		"shipping",
		"closed",
	];

	const idx = forwardPath.indexOf(current);
	if (idx === -1 || idx === forwardPath.length - 1) return null;
	return forwardPath[idx + 1] ?? null;
}

export function isHumanGate(status: SliceStatus): boolean {
	return HUMAN_GATES.includes(status);
}

export function canTransitionMilestone(from: MilestoneStatus, to: MilestoneStatus): boolean {
	return MILESTONE_TRANSITIONS[from].includes(to);
}
