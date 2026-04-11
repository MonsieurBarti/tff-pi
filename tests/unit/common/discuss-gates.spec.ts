import { beforeEach, describe, expect, it } from "vitest";
import {
	DISCUSS_GATES,
	isGateUnlocked,
	resetAllGates,
	resetGates,
	unlockGate,
} from "../../../src/common/discuss-gates.js";

describe("discuss-gates", () => {
	beforeEach(() => {
		resetGates("test-slice-1");
		resetGates("test-slice-2");
	});

	it("exports both gate keys", () => {
		expect(DISCUSS_GATES).toEqual(["depth_verified", "tier_confirmed"]);
	});

	it("gates start locked", () => {
		expect(isGateUnlocked("test-slice-1", "depth_verified")).toBe(false);
		expect(isGateUnlocked("test-slice-1", "tier_confirmed")).toBe(false);
	});

	it("unlockGate sets the flag", () => {
		unlockGate("test-slice-1", "depth_verified");
		expect(isGateUnlocked("test-slice-1", "depth_verified")).toBe(true);
		expect(isGateUnlocked("test-slice-1", "tier_confirmed")).toBe(false);
	});

	it("gates are isolated per slice", () => {
		unlockGate("test-slice-1", "depth_verified");
		expect(isGateUnlocked("test-slice-2", "depth_verified")).toBe(false);
	});

	it("resetGates clears all flags for a slice", () => {
		unlockGate("test-slice-1", "depth_verified");
		unlockGate("test-slice-1", "tier_confirmed");
		resetGates("test-slice-1");
		expect(isGateUnlocked("test-slice-1", "depth_verified")).toBe(false);
		expect(isGateUnlocked("test-slice-1", "tier_confirmed")).toBe(false);
	});

	it("resetAllGates clears all slices", () => {
		unlockGate("test-slice-1", "depth_verified");
		unlockGate("test-slice-2", "tier_confirmed");
		resetAllGates();
		expect(isGateUnlocked("test-slice-1", "depth_verified")).toBe(false);
		expect(isGateUnlocked("test-slice-2", "tier_confirmed")).toBe(false);
	});
});
