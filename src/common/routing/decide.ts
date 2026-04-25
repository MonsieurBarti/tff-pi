import { randomUUID } from "node:crypto";
import type { ModelTier } from "./agent-capability.js";
import type { WorkflowPool } from "./pool.js";
import { scoreAgents } from "./routing-rubric.js";
import type { Signals } from "./signals.js";
import { type TierPolicy, resolveEffectiveTier, signalsToPolicyTier } from "./tier-resolver.js";

export interface AgentDecision {
	agent_id: string;
	tier: ModelTier | null;
	policy_tier: ModelTier | null;
	min_tier_applied: boolean;
	confidence: number;
	fallback_used: boolean;
	route_decision_id: string;
	tier_decision_id: string;
}

export interface DecideOptions {
	confidence_threshold: number;
	policy?: TierPolicy;
	uuid?: () => string;
}

export function decide(
	signals: Signals,
	pool: WorkflowPool,
	opts: DecideOptions = { confidence_threshold: 0 },
): AgentDecision[] {
	const uuid = opts.uuid ?? randomUUID;
	const policy_tier = signalsToPolicyTier(signals, opts.policy);
	const decisions: AgentDecision[] = [];
	for (const agent of pool.agents) {
		const subPool: WorkflowPool = { phase: pool.phase, agents: [agent] };
		const ranked = scoreAgents(subPool, signals);
		const confidence = ranked[0]?.match_ratio ?? 0;
		const fallback_used = confidence < opts.confidence_threshold;
		const { tier, min_tier_applied } = resolveEffectiveTier(policy_tier, agent.min_tier);
		decisions.push({
			agent_id: agent.id,
			tier,
			policy_tier,
			min_tier_applied,
			confidence,
			fallback_used,
			route_decision_id: uuid(),
			tier_decision_id: uuid(),
		});
	}
	return decisions;
}
