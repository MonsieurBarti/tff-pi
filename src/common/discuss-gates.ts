export const DISCUSS_GATES = ["depth_verified", "tier_confirmed"] as const;
export type DiscussGate = (typeof DISCUSS_GATES)[number];

const gateState = new Map<string, Set<DiscussGate>>();

export function isGateUnlocked(sliceId: string, gate: DiscussGate): boolean {
	return gateState.get(sliceId)?.has(gate) ?? false;
}

export function unlockGate(sliceId: string, gate: DiscussGate): void {
	let gates = gateState.get(sliceId);
	if (!gates) {
		gates = new Set();
		gateState.set(sliceId, gates);
	}
	gates.add(gate);
}

export function resetGates(sliceId: string): void {
	gateState.delete(sliceId);
}
