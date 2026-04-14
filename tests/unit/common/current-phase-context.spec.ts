import { afterEach, describe, expect, it } from "vitest";
import {
	clearCurrentPhase,
	getCurrentPhase,
	setCurrentPhase,
} from "../../../src/common/current-phase-context.js";

describe("current-phase-context", () => {
	afterEach(() => {
		clearCurrentPhase();
	});

	it("returns null by default", () => {
		expect(getCurrentPhase()).toBeNull();
	});

	it("set + get returns the stored value", () => {
		setCurrentPhase({
			sliceId: "slice-1",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});
		expect(getCurrentPhase()).toEqual({
			sliceId: "slice-1",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});
	});

	it("clear resets to null", () => {
		setCurrentPhase({
			sliceId: "slice-1",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});
		clearCurrentPhase();
		expect(getCurrentPhase()).toBeNull();
	});

	it("double-set throws to fail fast if concurrent-phase assumption breaks", () => {
		setCurrentPhase({
			sliceId: "slice-1",
			sliceLabel: "M09-S01",
			milestoneNumber: 9,
			phase: "execute",
		});
		expect(() =>
			setCurrentPhase({
				sliceId: "slice-2",
				sliceLabel: "M09-S02",
				milestoneNumber: 9,
				phase: "verify",
			}),
		).toThrow(/current phase already set/i);
	});
});
