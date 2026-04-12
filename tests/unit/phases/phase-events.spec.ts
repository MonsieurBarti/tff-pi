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

import { discussPhase } from "../../../src/phases/discuss.js";
import { planPhase } from "../../../src/phases/plan.js";
import { researchPhase } from "../../../src/phases/research.js";

function makeCtx(
	db: Database.Database,
	root: string,
	sliceId: string,
	mockEmit: ReturnType<typeof vi.fn>,
): PhaseContext {
	const slice = must(getSlice(db, sliceId));
	return {
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
}

function setupDb(milestoneStatus?: string): {
	db: Database.Database;
	root: string;
	sliceId: string;
} {
	const db = openDatabase(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-phase-events-"));
	initTffDirectory(root);
	insertProject(db, { name: "TFF", vision: "Vision" });
	const projectId = must(getProject(db)).id;
	insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
	const milestoneId = must(getMilestones(db, projectId)[0]).id;
	insertSlice(db, { milestoneId, number: 1, title: "Auth" });
	const sliceId = must(getSlices(db, milestoneId)[0]).id;
	updateSliceTier(db, sliceId, "SS");
	writeArtifact(root, "PROJECT.md", "# TFF");
	if (milestoneStatus) {
		updateSliceStatus(db, sliceId, milestoneStatus as Parameters<typeof updateSliceStatus>[2]);
	}
	return { db, root, sliceId };
}

describe("phase event emission", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	describe("discussPhase", () => {
		beforeEach(() => {
			({ db, root, sliceId } = setupDb());
		});

		it("emits phase_start on entry", async () => {
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await discussPhase.prepare(ctx);

			const startCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "discuss",
			);
			expect(startCalls).toHaveLength(1);
		});

		it("does NOT emit phase_complete (tracked on /tff next)", async () => {
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await discussPhase.prepare(ctx);

			expect(result.success).toBe(true);
			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "discuss",
			);
			expect(completeCalls).toHaveLength(0);
		});
	});

	describe("researchPhase", () => {
		beforeEach(() => {
			({ db, root, sliceId } = setupDb("discussing"));
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
		});

		it("emits phase_start on entry", async () => {
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await researchPhase.prepare(ctx);

			const startCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "research",
			);
			expect(startCalls).toHaveLength(1);
		});

		it("does NOT emit phase_complete (tracked on /tff next)", async () => {
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await researchPhase.prepare(ctx);

			expect(result.success).toBe(true);
			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "research",
			);
			expect(completeCalls).toHaveLength(0);
		});
	});

	describe("planPhase", () => {
		beforeEach(() => {
			({ db, root, sliceId } = setupDb("researching"));
			writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec");
			writeArtifact(root, "milestones/M01/slices/M01-S01/RESEARCH.md", "# Research");
		});

		it("emits phase_start on entry", async () => {
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await planPhase.prepare(ctx);

			const startCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start" && e.phase === "plan",
			);
			expect(startCalls).toHaveLength(1);
		});

		it("does NOT emit phase_complete (tracked on /tff next)", async () => {
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			const result = await planPhase.prepare(ctx);

			expect(result.success).toBe(true);
			const completeCalls = mockEmit.mock.calls.filter(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "plan",
			);
			expect(completeCalls).toHaveLength(0);
		});
	});

	describe("base event fields", () => {
		it("phase_start includes sliceId, sliceLabel, milestoneNumber, timestamp", async () => {
			({ db, root, sliceId } = setupDb());
			const mockEmit = vi.fn();
			const ctx = makeCtx(db, root, sliceId, mockEmit);
			await discussPhase.prepare(ctx);

			const startCall = mockEmit.mock.calls.find(
				([ch, e]) => ch === "tff:phase" && e.type === "phase_start",
			);
			expect(startCall).toBeDefined();
			const event = startCall?.[1];
			expect(event).toHaveProperty("sliceId");
			expect(event).toHaveProperty("sliceLabel", "M01-S01");
			expect(event).toHaveProperty("milestoneNumber", 1);
			expect(event).toHaveProperty("timestamp");
		});
	});
});
