import { describe, expect, it } from "vitest";
import type { AgentCapability } from "../../../../src/common/routing/agent-capability.js";
import { scoreAgents, signalsToTagSet } from "../../../../src/common/routing/routing-rubric.js";
import type { Signals } from "../../../../src/common/routing/signals.js";

const mkAgent = (id: string, handles: string[], priority = 0): AgentCapability => ({
	id,
	handles,
	priority,
});

describe("signalsToTagSet", () => {
	it("includes complexity, risk level, and tag set", () => {
		const tags = signalsToTagSet({
			complexity: "medium",
			risk: { level: "high", tags: ["auth"] },
		});
		expect(tags.has("medium_complexity")).toBe(true);
		expect(tags.has("high_risk")).toBe(true);
		expect(tags.has("auth")).toBe(true);
	});
});

describe("scoreAgents", () => {
	const signals: Signals = {
		complexity: "medium",
		risk: { level: "high", tags: ["auth"] },
	};
	const a1 = mkAgent("a1", ["high_risk", "auth"], 5);
	const a2 = mkAgent("a2", ["high_risk"], 5);
	const a3 = mkAgent("a3", ["high_risk", "auth"], 9);

	it("AC-04: ranks agent with more matched handles first", () => {
		const ranked = scoreAgents({ phase: "review", agents: [a2, a1] }, signals);
		expect(ranked.map((r) => r.agent.id)).toEqual(["a1", "a2"]);
	});
	it("AC-04: breaks ties by priority DESC", () => {
		const ranked = scoreAgents({ phase: "review", agents: [a1, a3] }, signals);
		expect(ranked.map((r) => r.agent.id)).toEqual(["a3", "a1"]);
	});
	it("match_ratio = matches / max(signalTags.size, 1)", () => {
		const ranked = scoreAgents({ phase: "review", agents: [a2] }, signals);
		expect(ranked[0]?.match_ratio).toBeCloseTo(1 / 3);
	});
});
