import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
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
import { handleShipApplyDone } from "../../../src/tools/ship-apply-done.js";
import { must } from "../../helpers.js";

function makePi() {
	return {
		events: { emit: vi.fn() },
	} as unknown as Parameters<typeof handleShipApplyDone>[0];
}

describe("handleShipApplyDone", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;
	let feedbackPath: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-ship-apply-done-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "v" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "slice" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW_FEEDBACK.md", "# feedback");
		feedbackPath = join(
			root,
			".tff",
			"milestones",
			"M01",
			"slices",
			"M01-S01",
			"REVIEW_FEEDBACK.md",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("deletes REVIEW_FEEDBACK.md and emits phase_complete on success", () => {
		const pi = makePi();
		const result = handleShipApplyDone(pi, db, root, { sliceLabel: sliceId });
		expect(result.success).toBe(true);
		expect(existsSync(feedbackPath)).toBe(false);

		const emit = pi.events.emit as ReturnType<typeof vi.fn>;
		const call = must(
			emit.mock.calls.find((c) => (c[1] as { type?: string })?.type === "phase_complete"),
		);
		expect((call[1] as { phase?: string }).phase).toBe("ship");
	});

	it("emits phase_failed when rejected=true", () => {
		const pi = makePi();
		const result = handleShipApplyDone(pi, db, root, { sliceLabel: sliceId, rejected: true });
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/rejected/i);
		expect(existsSync(feedbackPath)).toBe(false);

		const emit = pi.events.emit as ReturnType<typeof vi.fn>;
		const failedCall = emit.mock.calls.find(
			(c) => (c[1] as { type?: string })?.type === "phase_failed",
		);
		expect(failedCall).toBeTruthy();
	});

	it("returns not-found for unknown slice", () => {
		const result = handleShipApplyDone(makePi(), db, root, { sliceLabel: "nope" });
		expect(result.success).toBe(false);
		expect(result.message).toContain("not found");
	});

	it("is idempotent when REVIEW_FEEDBACK.md is already gone", () => {
		rmSync(feedbackPath);
		const result = handleShipApplyDone(makePi(), db, root, { sliceLabel: sliceId });
		expect(result.success).toBe(true);
	});
});
