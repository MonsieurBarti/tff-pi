import { type ModelTier, TIER_ORDER } from "./agent-capability.js";
import type { ComplexityLevel, RiskLevel, Signals } from "./signals.js";

export type TierPolicy = Record<ComplexityLevel | RiskLevel, ModelTier>;

export function signalsToPolicyTier(
	signals: Signals,
	policy: TierPolicy | undefined,
): ModelTier | null {
	if (!policy) return null;
	const ct = policy[signals.complexity];
	const rt = policy[signals.risk.level];
	return TIER_ORDER[ct] >= TIER_ORDER[rt] ? ct : rt;
}

export function resolveEffectiveTier(
	policyTier: ModelTier | null,
	minTier: ModelTier | undefined,
): { tier: ModelTier | null; min_tier_applied: boolean } {
	if (minTier === undefined) return { tier: policyTier, min_tier_applied: false };
	if (policyTier === null) return { tier: minTier, min_tier_applied: true };
	if (TIER_ORDER[policyTier] >= TIER_ORDER[minTier]) {
		return { tier: policyTier, min_tier_applied: false };
	}
	return { tier: minTier, min_tier_applied: true };
}
