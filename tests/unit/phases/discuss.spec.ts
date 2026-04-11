import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

vi.mock("../../../src/common/dispatch.js", () => ({
	dispatchSubAgent: vi.fn().mockResolvedValue({ success: true, output: "done" }),
	buildSubagentTask: vi.fn().mockReturnValue("task"),
}));

vi.mock("../../../src/common/plannotator-review.js", () => ({
	requestReview: vi.fn().mockResolvedValue({ approved: true }),
	buildReviewRequest: vi.fn(),
}));

import { discussPhase } from "../../../src/phases/discuss.js";

describe("discussPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-discuss-phase-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		writeArtifact(root, "PROJECT.md", "# TFF");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof discussPhase.run).toBe("function");
	});

	it("returns success when agent and gate pass", async () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# Requirements");
		updateSliceTier(db, sliceId, "SS");
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: { events: { emit: vi.fn(), on: vi.fn() } } as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await discussPhase.run(ctx);
		expect(result.success).toBe(true);
	});
});
