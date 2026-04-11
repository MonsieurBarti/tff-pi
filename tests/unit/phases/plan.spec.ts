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
	updateSliceStatus,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

import { planPhase } from "../../../src/phases/plan.js";

describe("planPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-plan-phase-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceStatus(db, sliceId, "researching");
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "PROJECT.md", "# TFF");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/RESEARCH.md", "# Research");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof planPhase.run).toBe("function");
	});

	it("returns success and sends message", async () => {
		const slice = must(getSlice(db, sliceId));
		const sendUserMessage = vi.fn();
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage,
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		const result = await planPhase.run(ctx);
		expect(result.success).toBe(true);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("transitions to planning during run", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: vi.fn(), on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await planPhase.run(ctx);
		const updated = must(getSlice(db, sliceId));
		expect(updated.status).toBe("planning");
	});
});
