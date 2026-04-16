import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import { computeNextHint } from "../../../src/common/phase-completion.js";
import type { Slice, SliceStatus } from "../../../src/common/types.js";
import { must } from "../../helpers.js";

function setupOneSlice(status: SliceStatus, tier: "S" | "SS" | "SSS" = "SS") {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	insertProject(db, { name: "TFF", vision: "V" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, tier);
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(status, sliceId);
	const slice = must(getSlices(db, milestoneId).find((s) => s.id === sliceId));
	return { db, slice, milestoneNumber: 1, milestoneId };
}

describe("computeNextHint", () => {
	it("created → discuss", () => {
		const { db, slice } = setupOneSlice("created");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff discuss M01-S01");
	});

	it("discussing + SS → research", () => {
		const { db, slice } = setupOneSlice("discussing", "SS");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff research M01-S01");
	});

	it("discussing + S → plan (skip research)", () => {
		const { db, slice } = setupOneSlice("discussing", "S");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff plan M01-S01");
	});

	it("researching → plan", () => {
		const { db, slice } = setupOneSlice("researching");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff plan M01-S01");
	});

	it("planning → execute", () => {
		const { db, slice } = setupOneSlice("planning");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff execute M01-S01");
	});

	it("executing → verify", () => {
		const { db, slice } = setupOneSlice("executing");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff verify M01-S01");
	});

	it("verifying → review", () => {
		const { db, slice } = setupOneSlice("verifying");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff review M01-S01");
	});

	it("reviewing → ship", () => {
		const { db, slice } = setupOneSlice("reviewing");
		expect(computeNextHint(db, slice, 1)).toBe("→ Next: /tff ship M01-S01");
	});

	it("shipped slice + more open slices → next open slice's discuss", () => {
		const { db, slice, milestoneId } = setupOneSlice("shipping");
		insertSlice(db, { milestoneId, number: 2, title: "S2" });
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(slice.id);
		const closedSlice: Slice = { ...slice, status: "closed" };
		// The next open slice (S2) has status 'created', so its next phase is 'discuss'
		expect(computeNextHint(db, closedSlice, 1)).toBe("→ Next: /tff discuss M01-S02");
	});

	it("shipped final slice (no more open slices) → /tff complete-milestone", () => {
		const { db, slice } = setupOneSlice("shipping");
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(slice.id);
		const closedSlice: Slice = { ...slice, status: "closed" };
		expect(computeNextHint(db, closedSlice, 1)).toBe("→ Next: /tff complete-milestone");
	});
});
