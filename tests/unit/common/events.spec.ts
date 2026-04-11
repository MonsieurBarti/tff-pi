import { describe, expect, it } from "vitest";
import { type PhaseEvent, TFF_CHANNELS, makeBaseEvent } from "../../../src/common/events.js";

describe("events", () => {
	it("exports all 5 channels", () => {
		expect(TFF_CHANNELS).toEqual([
			"tff:phase",
			"tff:task",
			"tff:wave",
			"tff:review",
			"tff:pipeline",
		]);
	});

	it("makeBaseEvent creates envelope with ISO timestamp", () => {
		const base = makeBaseEvent("slice-1", "M01-S01", 1);
		expect(base.sliceId).toBe("slice-1");
		expect(base.sliceLabel).toBe("M01-S01");
		expect(base.milestoneNumber).toBe(1);
		expect(() => new Date(base.timestamp).toISOString()).not.toThrow();
	});

	it("PhaseEvent type is assignable with all fields", () => {
		const event: PhaseEvent = {
			...makeBaseEvent("s1", "M01-S01", 1),
			type: "phase_start",
			phase: "discuss",
		};
		expect(event.type).toBe("phase_start");
	});
});
