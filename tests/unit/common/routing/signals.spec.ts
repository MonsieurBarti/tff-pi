import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { type Signals, SignalsSchema } from "../../../../src/common/routing/signals.js";

describe("SignalsSchema", () => {
	it("parses a valid Signals object", () => {
		const valid: Signals = {
			complexity: "high",
			risk: { level: "high", tags: ["auth", "secret"] },
		};
		expect(Value.Parse(SignalsSchema, valid)).toEqual(valid);
		expect(Value.Check(SignalsSchema, valid)).toBe(true);
	});

	it("throws on invalid complexity enum", () => {
		expect(() =>
			Value.Parse(SignalsSchema, {
				complexity: "critical",
				risk: { level: "high", tags: [] },
			}),
		).toThrow();
	});

	it("rejects missing risk.tags", () => {
		expect(
			Value.Check(SignalsSchema, {
				complexity: "low",
				risk: { level: "low" },
			}),
		).toBe(false);
	});
});
