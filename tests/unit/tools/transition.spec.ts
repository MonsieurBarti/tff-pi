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
	updateSliceStatus,
} from "../../../src/common/db.js";
import { handleTransition } from "../../../src/tools/transition.js";
import { must } from "../../helpers.js";

function createTestDb(): Database.Database {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	return db;
}

function makeMockPi(): ExtensionAPI {
	return {
		events: {
			emit: vi.fn(),
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
		pi = makeMockPi();
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
		updateSliceStatus(db, sliceId, "discussing");
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
		updateSliceStatus(db, sliceId, "shipping");
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
		updateSliceStatus(db, sliceId, "closed");
		const result = handleTransition(pi, db, sliceId, 1);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toContain("No valid next status");
	});
});
