import { describe, expect, it } from "vitest";
import type {
	AgentCapability,
	ModelTier,
} from "../../../../src/common/routing/agent-capability.js";
import { decide } from "../../../../src/common/routing/decide.js";
import type { Signals } from "../../../../src/common/routing/signals.js";
import type { TierPolicy } from "../../../../src/common/routing/tier-resolver.js";

const a = (id: string, handles: string[], min_tier?: ModelTier, priority = 0): AgentCapability => {
	const base = { id, handles, priority };
	return min_tier === undefined ? base : { ...base, min_tier };
};

const signals: Signals = { complexity: "medium", risk: { level: "high", tags: ["auth"] } };
const policy: TierPolicy = { low: "haiku", medium: "sonnet", high: "opus" };
const fixedUuid = () => {
	let n = 0;
	return () => `uuid-${++n}`;
};

describe("decide()", () => {
	it("AC-01: pure — same input → deeply-equal output", () => {
		const pool = { phase: "review" as const, agents: [a("r1", ["high_risk"], undefined, 1)] };
		const r1 = decide(signals, pool, { confidence_threshold: 0, policy, uuid: fixedUuid() });
		const r2 = decide(signals, pool, { confidence_threshold: 0, policy, uuid: fixedUuid() });
		expect(r1).toEqual(r2);
	});
	it("AC-02: policy undefined + no min_tier → all nulls, not applied", () => {
		const pool = { phase: "review" as const, agents: [a("r1", ["high_risk"])] };
		const decisions = decide(signals, pool, { confidence_threshold: 0, uuid: fixedUuid() });
		const d = decisions[0];
		expect(d).toBeDefined();
		expect(d?.tier).toBeNull();
		expect(d?.policy_tier).toBeNull();
		expect(d?.min_tier_applied).toBe(false);
	});
	it("AC-02: policy undefined + min_tier sonnet → tier sonnet, applied", () => {
		const pool = { phase: "review" as const, agents: [a("r1", [], "sonnet")] };
		const decisions = decide(signals, pool, { confidence_threshold: 0, uuid: fixedUuid() });
		const d = decisions[0];
		expect(d).toBeDefined();
		expect(d?.tier).toBe("sonnet");
		expect(d?.policy_tier).toBeNull();
		expect(d?.min_tier_applied).toBe(true);
	});
	it("one-agent → one-decision (curation upstream)", () => {
		const pool = { phase: "review" as const, agents: [a("r1", []), a("r2", [])] };
		expect(decide(signals, pool, { confidence_threshold: 0, uuid: fixedUuid() })).toHaveLength(2);
	});
	it("confidence reflects scoreAgents on a sub-pool of [agent]", () => {
		const pool = {
			phase: "review" as const,
			agents: [a("r1", ["high_risk", "auth", "medium_complexity"])],
		};
		const decisions = decide(signals, pool, { confidence_threshold: 0, uuid: fixedUuid() });
		const d = decisions[0];
		expect(d).toBeDefined();
		expect(d?.confidence).toBeCloseTo(1.0);
		expect(d?.fallback_used).toBe(false);
	});
	it("fallback_used flips when confidence < threshold", () => {
		const pool = { phase: "review" as const, agents: [a("r1", [])] };
		const decisions = decide(signals, pool, { confidence_threshold: 0.5, uuid: fixedUuid() });
		const d = decisions[0];
		expect(d).toBeDefined();
		expect(d?.confidence).toBe(0);
		expect(d?.fallback_used).toBe(true);
	});
});
