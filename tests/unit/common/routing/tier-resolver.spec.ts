import { describe, expect, it } from "vitest";
import type { Signals } from "../../../../src/common/routing/signals.js";
import {
	resolveEffectiveTier,
	signalsToPolicyTier,
} from "../../../../src/common/routing/tier-resolver.js";

const policy = { low: "haiku", medium: "sonnet", high: "opus" } as const;

describe("signalsToPolicyTier", () => {
	it("returns null when policy is undefined", () => {
		const s: Signals = { complexity: "medium", risk: { level: "low", tags: [] } };
		expect(signalsToPolicyTier(s, undefined)).toBeNull();
	});
	it("AC-03: low complexity + high risk + standard policy → opus (risk wins)", () => {
		const s: Signals = { complexity: "low", risk: { level: "high", tags: [] } };
		expect(signalsToPolicyTier(s, policy)).toBe("opus");
	});
	it("complexity wins when greater than risk", () => {
		const s: Signals = { complexity: "high", risk: { level: "low", tags: [] } };
		expect(signalsToPolicyTier(s, policy)).toBe("opus");
	});
});

describe("resolveEffectiveTier", () => {
	it("policy null + min_tier undefined → null, not applied", () => {
		expect(resolveEffectiveTier(null, undefined)).toEqual({ tier: null, min_tier_applied: false });
	});
	it("policy null + min_tier sonnet → sonnet, applied", () => {
		expect(resolveEffectiveTier(null, "sonnet")).toEqual({
			tier: "sonnet",
			min_tier_applied: true,
		});
	});
	it("policy haiku + min_tier sonnet → sonnet, applied (floor wins)", () => {
		expect(resolveEffectiveTier("haiku", "sonnet")).toEqual({
			tier: "sonnet",
			min_tier_applied: true,
		});
	});
	it("policy opus + min_tier haiku → opus, not applied (policy wins)", () => {
		expect(resolveEffectiveTier("opus", "haiku")).toEqual({
			tier: "opus",
			min_tier_applied: false,
		});
	});
	it("policy sonnet + min_tier sonnet → sonnet, not applied (tie → policy wins)", () => {
		expect(resolveEffectiveTier("sonnet", "sonnet")).toEqual({
			tier: "sonnet",
			min_tier_applied: false,
		});
	});
});
