import type { MilestoneStatus, SliceStatus, Tier } from "./types.js";

export const SLICE_TRANSITIONS: Record<SliceStatus, SliceStatus[]> = {
	created: ["discussing"],
	discussing: ["researching", "planning", "paused"],
	researching: ["planning", "paused"],
	planning: ["executing", "paused"],
	executing: ["verifying", "paused"],
	verifying: ["reviewing", "executing", "paused"],
	reviewing: ["shipping", "executing", "paused"],
	shipping: ["closed", "executing", "paused"],
	closed: [],
	paused: [
		"discussing",
		"researching",
		"planning",
		"executing",
		"verifying",
		"reviewing",
		"shipping",
	],
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
	if (current === "closed" || current === "paused") return null;
	if (current === "discussing" && tier === "S") return "planning";

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
