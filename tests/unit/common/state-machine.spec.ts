import { describe, expect, it } from "vitest";
import {
	HUMAN_GATES,
	SLICE_TRANSITIONS,
	canTransitionMilestone,
	canTransitionSlice,
	isHumanGate,
	nextSliceStatus,
} from "../../../src/common/state-machine.js";

describe("state-machine", () => {
	describe("SLICE_TRANSITIONS", () => {
		it("defines transitions for all slice statuses", () => {
			expect(SLICE_TRANSITIONS).toHaveProperty("created");
			expect(SLICE_TRANSITIONS).toHaveProperty("discussing");
			expect(SLICE_TRANSITIONS).toHaveProperty("researching");
			expect(SLICE_TRANSITIONS).toHaveProperty("planning");
			expect(SLICE_TRANSITIONS).toHaveProperty("executing");
			expect(SLICE_TRANSITIONS).toHaveProperty("verifying");
			expect(SLICE_TRANSITIONS).toHaveProperty("reviewing");
			expect(SLICE_TRANSITIONS).toHaveProperty("shipping");
			expect(SLICE_TRANSITIONS).toHaveProperty("closed");
			expect(SLICE_TRANSITIONS).toHaveProperty("paused");
		});
	});

	describe("canTransitionSlice", () => {
		it("allows valid forward path: created → discussing", () => {
			expect(canTransitionSlice("created", "discussing")).toBe(true);
		});

		it("allows valid forward path: discussing → researching", () => {
			expect(canTransitionSlice("discussing", "researching")).toBe(true);
		});

		it("allows S-tier skip: discussing → planning", () => {
			expect(canTransitionSlice("discussing", "planning")).toBe(true);
		});

		it("allows valid forward path: researching → planning", () => {
			expect(canTransitionSlice("researching", "planning")).toBe(true);
		});

		it("allows valid forward path: planning → executing", () => {
			expect(canTransitionSlice("planning", "executing")).toBe(true);
		});

		it("allows valid forward path: executing → verifying", () => {
			expect(canTransitionSlice("executing", "verifying")).toBe(true);
		});

		it("allows back-edge: verifying → executing (AC fail)", () => {
			expect(canTransitionSlice("verifying", "executing")).toBe(true);
		});

		it("allows valid forward path: verifying → reviewing", () => {
			expect(canTransitionSlice("verifying", "reviewing")).toBe(true);
		});

		it("allows back-edge: reviewing → executing (changes requested)", () => {
			expect(canTransitionSlice("reviewing", "executing")).toBe(true);
		});

		it("allows valid forward path: reviewing → shipping", () => {
			expect(canTransitionSlice("reviewing", "shipping")).toBe(true);
		});

		it("allows valid forward path: shipping → closed", () => {
			expect(canTransitionSlice("shipping", "closed")).toBe(true);
		});

		it("allows pause from any active phase: discussing → paused", () => {
			expect(canTransitionSlice("discussing", "paused")).toBe(true);
		});

		it("allows pause from any active phase: executing → paused", () => {
			expect(canTransitionSlice("executing", "paused")).toBe(true);
		});

		it("allows pause from any active phase: shipping → paused", () => {
			expect(canTransitionSlice("shipping", "paused")).toBe(true);
		});

		it("allows resume from paused: paused → discussing", () => {
			expect(canTransitionSlice("paused", "discussing")).toBe(true);
		});

		it("allows resume from paused: paused → executing", () => {
			expect(canTransitionSlice("paused", "executing")).toBe(true);
		});

		it("rejects invalid transition: created → planning", () => {
			expect(canTransitionSlice("created", "planning")).toBe(false);
		});

		it("rejects invalid transition: closed → discussing", () => {
			expect(canTransitionSlice("closed", "discussing")).toBe(false);
		});

		it("rejects invalid transition: executing → discussing", () => {
			expect(canTransitionSlice("executing", "discussing")).toBe(false);
		});

		it("rejects self-transition", () => {
			expect(canTransitionSlice("discussing", "discussing")).toBe(false);
		});
	});

	describe("nextSliceStatus", () => {
		it("returns discussing from created", () => {
			expect(nextSliceStatus("created")).toBe("discussing");
		});

		it("returns researching from discussing (default/no tier)", () => {
			expect(nextSliceStatus("discussing")).toBe("researching");
		});

		it("skips researching for S-tier: discussing → planning", () => {
			expect(nextSliceStatus("discussing", "S")).toBe("planning");
		});

		it("skips researching for SS-tier: discussing → planning", () => {
			expect(nextSliceStatus("discussing", "SS")).toBe("planning");
		});

		it("skips researching for SSS-tier: discussing → planning", () => {
			expect(nextSliceStatus("discussing", "SSS")).toBe("planning");
		});

		it("returns planning from researching", () => {
			expect(nextSliceStatus("researching")).toBe("planning");
		});

		it("returns executing from planning", () => {
			expect(nextSliceStatus("planning")).toBe("executing");
		});

		it("returns verifying from executing", () => {
			expect(nextSliceStatus("executing")).toBe("verifying");
		});

		it("returns reviewing from verifying", () => {
			expect(nextSliceStatus("verifying")).toBe("reviewing");
		});

		it("returns shipping from reviewing", () => {
			expect(nextSliceStatus("reviewing")).toBe("shipping");
		});

		it("returns closed from shipping", () => {
			expect(nextSliceStatus("shipping")).toBe("closed");
		});

		it("returns null for closed", () => {
			expect(nextSliceStatus("closed")).toBeNull();
		});

		it("returns null for paused", () => {
			expect(nextSliceStatus("paused")).toBeNull();
		});
	});

	describe("isHumanGate", () => {
		it("returns true for discussing", () => {
			expect(isHumanGate("discussing")).toBe(true);
		});

		it("returns true for planning", () => {
			expect(isHumanGate("planning")).toBe(true);
		});

		it("returns true for shipping", () => {
			expect(isHumanGate("shipping")).toBe(true);
		});

		it("returns false for executing", () => {
			expect(isHumanGate("executing")).toBe(false);
		});

		it("returns false for verifying", () => {
			expect(isHumanGate("verifying")).toBe(false);
		});

		it("returns false for closed", () => {
			expect(isHumanGate("closed")).toBe(false);
		});
	});

	describe("HUMAN_GATES", () => {
		it("contains discussing, planning, shipping", () => {
			expect(HUMAN_GATES).toEqual(["discussing", "planning", "shipping"]);
		});
	});

	describe("canTransitionMilestone", () => {
		it("allows created → in_progress", () => {
			expect(canTransitionMilestone("created", "in_progress")).toBe(true);
		});

		it("allows in_progress → completing", () => {
			expect(canTransitionMilestone("in_progress", "completing")).toBe(true);
		});

		it("allows completing → closed", () => {
			expect(canTransitionMilestone("completing", "closed")).toBe(true);
		});

		it("rejects closed → any", () => {
			expect(canTransitionMilestone("closed", "in_progress")).toBe(false);
			expect(canTransitionMilestone("closed", "created")).toBe(false);
		});

		it("rejects skipping: created → completing", () => {
			expect(canTransitionMilestone("created", "completing")).toBe(false);
		});

		it("rejects backwards: in_progress → created", () => {
			expect(canTransitionMilestone("in_progress", "created")).toBe(false);
		});

		it("rejects self-transition", () => {
			expect(canTransitionMilestone("in_progress", "in_progress")).toBe(false);
		});
	});
});
