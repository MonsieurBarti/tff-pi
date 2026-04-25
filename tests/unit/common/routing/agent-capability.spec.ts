import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
	AgentCapabilitySchema,
	ModelTierSchema,
	TIER_ORDER,
} from "../../../../src/common/routing/agent-capability.js";

describe("AgentCapabilitySchema", () => {
	it("AC-01: accepts valid capability w/ min_tier; rejects invalid min_tier", () => {
		expect(
			Value.Check(AgentCapabilitySchema, {
				id: "tff-foo",
				handles: ["a"],
				priority: 5,
				min_tier: "sonnet",
			}),
		).toBe(true);
		expect(
			Value.Check(AgentCapabilitySchema, {
				id: "tff-foo",
				handles: ["a"],
				priority: 5,
				min_tier: "ultra",
			}),
		).toBe(false);
	});

	it("AC-02: min_tier optional; id regex enforced", () => {
		expect(Value.Check(AgentCapabilitySchema, { id: "tff-foo", handles: [], priority: 0 })).toBe(
			true,
		);
		expect(Value.Check(AgentCapabilitySchema, { id: "Bad-ID", handles: [], priority: 0 })).toBe(
			false,
		);
	});
});

describe("ModelTierSchema + TIER_ORDER", () => {
	it("AC-08: TIER_ORDER values", () => {
		expect(TIER_ORDER).toEqual({ haiku: 0, sonnet: 1, opus: 2 });
	});

	it("AC-08: ModelTierSchema is an exported named export accepting the three tiers", () => {
		for (const t of ["haiku", "sonnet", "opus"]) {
			expect(Value.Check(ModelTierSchema, t)).toBe(true);
		}
		expect(Value.Check(ModelTierSchema, "ultra")).toBe(false);
	});
});
