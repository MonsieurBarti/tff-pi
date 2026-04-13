import type { Phase } from "./types.js";

export interface CurrentPhase {
	sliceId: string;
	sliceLabel: string;
	milestoneNumber: number;
	phase: Phase;
}

let current: CurrentPhase | null = null;

export function setCurrentPhase(ctx: CurrentPhase): void {
	if (current !== null) {
		throw new Error(
			`setCurrentPhase called while current phase already set (existing: ${current.sliceLabel}:${current.phase}). TFF runs one phase at a time; this indicates a lifecycle bug or a nested phase invocation.`,
		);
	}
	current = ctx;
}

export function clearCurrentPhase(): void {
	current = null;
}

export function getCurrentPhase(): CurrentPhase | null {
	return current;
}
