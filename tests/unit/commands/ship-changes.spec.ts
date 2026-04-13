import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.mock("../../../src/common/review-feedback.js", () => ({
	fetchReviewFeedback: (...args: unknown[]) => mockFetch(...args),
}));

import { handleShipChanges } from "../../../src/commands/ship-changes.js";
import { initTffDirectory } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getSlice,
	getTasksByWave,
	insertMilestone,
	insertProject,
	insertSlice,
	insertTask,
	openDatabase,
	updateSlicePrUrl,
	updateSliceStatus,
	updateTaskStatus,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function fakePi() {
	return {
		events: { emit: vi.fn() },
	} as unknown as Parameters<typeof handleShipChanges>[0];
}

describe("handleShipChanges", () => {
	let db: Database.Database;
	let sliceId: string;
	let root: string;

	beforeEach(() => {
		mockFetch.mockReset();
		root = mkdtempSync(join(tmpdir(), "tff-ship-changes-"));
		initTffDirectory(root);
		db = openDatabase(":memory:");
		applyMigrations(db);
		const projectId = insertProject(db, { name: "test", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});
		sliceId = insertSlice(db, { milestoneId, number: 1, title: "slice" });
		updateSliceStatus(db, sliceId, "shipping");
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("stashes provided feedback as an artifact and leaves slice in shipping", async () => {
		const taskId = insertTask(db, {
			sliceId,
			number: 1,
			title: "t",
			wave: 1,
		});
		updateTaskStatus(db, taskId, "closed");

		const result = await handleShipChanges(fakePi(), db, root, sliceId, "fix the thing");
		if (!result.success) throw new Error("expected success");
		expect(result.feedback).toBe("fix the thing");
		expect(result.autoFetched).toBe(false);

		const slice = must(getSlice(db, sliceId));
		expect(slice.status).toBe("shipping");

		const tasks = [...getTasksByWave(db, sliceId).values()].flat();
		expect(must(tasks[0]).status).toBe("closed");

		const feedbackPath = join(
			root,
			".tff",
			"milestones",
			"M01",
			"slices",
			"M01-S01",
			"REVIEW_FEEDBACK.md",
		);
		const body = readFileSync(feedbackPath, "utf-8");
		expect(body).toContain("fix the thing");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("refuses to reopen a closed slice", async () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = await handleShipChanges(fakePi(), db, root, sliceId, "feedback");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/closed/i);
	});

	it("auto-fetches feedback when none provided and writes the fetched markdown", async () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		mockFetch.mockReturnValue({
			markdown: "## Reviews\n\n### @alice — CHANGES_REQUESTED\n\nplease fix X\n",
			commentCount: 1,
		});

		const result = await handleShipChanges(fakePi(), db, root, sliceId);
		if (!result.success) throw new Error(`expected success, got: ${result.message}`);
		expect(result.autoFetched).toBe(true);
		expect(result.feedback).toContain("please fix X");

		const feedbackPath = join(
			root,
			".tff",
			"milestones",
			"M01",
			"slices",
			"M01-S01",
			"REVIEW_FEEDBACK.md",
		);
		const body = readFileSync(feedbackPath, "utf-8");
		expect(body).toContain("please fix X");
		expect(body).toContain("@alice");
		expect(mockFetch).toHaveBeenCalledWith("https://github.com/org/repo/pull/42");
	});

	it("errors when empty feedback and slice has no prUrl", async () => {
		const result = await handleShipChanges(fakePi(), db, root, sliceId);
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/no pr url/i);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("errors when prUrl exists but gh returns no feedback", async () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		mockFetch.mockReturnValue(null);

		const result = await handleShipChanges(fakePi(), db, root, sliceId, "   ");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.message).toMatch(/no review feedback/i);
	});

	it("skips auto-fetch when feedback is provided", async () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		const result = await handleShipChanges(fakePi(), db, root, sliceId, "explicit override");
		if (!result.success) throw new Error("expected success");
		expect(result.autoFetched).toBe(false);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
