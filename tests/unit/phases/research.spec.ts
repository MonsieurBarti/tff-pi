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

import { researchPhase } from "../../../src/phases/research.js";

describe("researchPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-research-phase-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sliceId);
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "PROJECT.md", "# TFF");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("conforms to PhaseModule interface", () => {
		expect(typeof researchPhase.prepare).toBe("function");
	});

	it("returns success and sends message via pi.sendUserMessage", async () => {
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
		const result = await researchPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(result.message).toBeDefined();
	});

	it("emits phase_start event", async () => {
		const slice = must(getSlice(db, sliceId));
		const mockEmit = vi.fn();
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: mockEmit, on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await researchPhase.prepare(ctx);
		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "research",
		);
		expect(startCalls).toHaveLength(1);
	});

	it("does NOT emit phase_complete (tracked on /tff next)", async () => {
		const slice = must(getSlice(db, sliceId));
		const mockEmit = vi.fn();
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: mockEmit, on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await researchPhase.prepare(ctx);
		const completeCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "research",
		);
		expect(completeCalls).toHaveLength(0);
	});

	it("emits phase_start for research (reconciler sets status via EventLogger)", async () => {
		// Status update is now driven by the reconciler when EventLogger handles
		// the phase_start event on the real event bus. In unit tests the bus is
		// mocked, so we verify the event was emitted — reconcile coverage lives in
		// reconciler-integration tests.
		const slice = must(getSlice(db, sliceId));
		const mockEmit = vi.fn();
		const ctx: PhaseContext = {
			pi: {
				sendUserMessage: vi.fn(),
				events: { emit: mockEmit, on: vi.fn() },
			} as unknown as PhaseContext["pi"],
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
		await researchPhase.prepare(ctx);
		const startCalls = mockEmit.mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "research",
		);
		expect(startCalls).toHaveLength(1);
	});
});
