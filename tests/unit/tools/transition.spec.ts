import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { expectedInProgressStatusFor } from "../../../src/common/derived-state.js";
import type { Phase } from "../../../src/common/types.js";
import { handleTransition } from "../../../src/tools/transition.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

// Simulates the event-logger's reconcile effect: on phase_start, sets
// slice.status to the phase's in-progress value. This keeps these validation
// tests focused on transition.ts logic without wiring up a full EventLogger.
function makeMockPi(db: Database.Database): ExtensionAPI {
	const emit = vi.fn((channel: string, data: unknown) => {
		if (channel !== "tff:phase") return;
		const event = data as { type?: string; phase?: Phase; sliceId?: string };
		if (event.type !== "phase_start" || !event.phase || !event.sliceId) return;
		const expected = expectedInProgressStatusFor(event.phase);
		if (expected) {
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(expected, event.sliceId);
		}
	});
	return {
		events: {
			emit,
			on: vi.fn(),
		},
	} as unknown as ExtensionAPI;
}

describe("handleTransition", () => {
	let db: Database.Database;
	let sliceId: string;
	let pi: ExtensionAPI;

	beforeEach(() => {
		db = createTestDb();
		pi = makeMockPi(db);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
	});

	it("returns error for non-existent slice", () => {
		const result = handleTransition(pi, db, "nonexistent", 1);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Slice not found");
	});

	it("auto-advances to next status when targetStatus omitted", () => {
		const result = handleTransition(pi, db, sliceId, 1);
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("created → discussing");
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_start", phase: "discuss" }),
		);
	});

	it("transitions to explicit valid targetStatus", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		const result = handleTransition(pi, db, sliceId, 1, "researching");
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toContain("discussing → researching");
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_start", phase: "research" }),
		);
	});

	it("returns error for invalid targetStatus string", () => {
		const result = handleTransition(pi, db, sliceId, 1, "bogus_status");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Invalid status: bogus_status");
	});

	it("rejects target 'closed' with pointer to /tff ship", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("shipping", sliceId);
		const result = handleTransition(pi, db, sliceId, 1, "closed");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("closed");
		expect(must(result.content[0]).text).toContain("/tff ship");
		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("returns error for disallowed transition", () => {
		// 'created' → 'researching' is not a valid direct transition
		const result = handleTransition(pi, db, sliceId, 1, "researching");
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("Invalid transition");
		expect(must(result.content[0]).text).toContain("Allowed from 'created': discussing");
	});

	it("returns error when no next status from closed", () => {
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", sliceId);
		const result = handleTransition(pi, db, sliceId, 1);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("No valid next status");
	});
});
