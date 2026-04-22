import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	writeArtifact,
} from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import { buildDiscussCompletionSuffix } from "../../../src/common/phase-completion.js";
import { must } from "../../helpers.js";

function fakePi(): { pi: ExtensionAPI; emit: ReturnType<typeof vi.fn> } {
	const emit = vi.fn();
	const pi = {
		events: { emit, on: vi.fn() },
	} as unknown as ExtensionAPI;
	return { pi, emit };
}

describe("buildDiscussCompletionSuffix", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-discuss-suffix-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(sliceId);
		initSliceDir(root, 1, 1);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reports progress (NOT completion) when only SPEC.md exists — regression for PR #53 premature-completion bug", () => {
		// Reproduces the bug seen in session 2026-04-21T18-46-Z: after
		// tff_write_spec landed SPEC.md, the tool message said "Discuss phase
		// complete. Stop here; the user will advance." The agent stopped,
		// user ran /tff research, and the predecessor-artifact check failed.
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# spec");
		const slice = must(getSlice(db, sliceId));
		const { pi, emit } = fakePi();

		const suffix = buildDiscussCompletionSuffix(pi, db, root, slice, 1);

		expect(suffix.isComplete).toBe(false);
		expect(suffix.text).toContain("REQUIREMENTS.md");
		expect(suffix.text).toContain("tier classification");
		expect(suffix.text).not.toContain("Discuss phase complete");
		expect(emit).not.toHaveBeenCalled();
	});

	it("reports completion only when SPEC.md, REQUIREMENTS.md, and tier are all present", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# req");
		updateSliceTier(db, sliceId, "SS");
		const slice = must(getSlice(db, sliceId));
		const { pi, emit } = fakePi();

		const suffix = buildDiscussCompletionSuffix(pi, db, root, slice, 1);

		expect(suffix.isComplete).toBe(true);
		expect(suffix.text).toContain("Discuss phase complete");
		expect(suffix.text).toContain("/tff research");
		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, event] = emit.mock.calls[0] ?? [];
		expect(channel).toBe("tff:phase");
		expect((event as { type?: string }).type).toBe("phase_complete");
	});

	it("S-tier hint skips research — next is /tff plan (regression: caller passed stale slice with tier=null)", () => {
		// Reproduces the bug: tff_classify resolves the slice, runs the classify
		// commit (which sets tier in DB), then calls buildDiscussCompletionSuffix
		// with the SNAPSHOT taken before the commit — slice.tier is still null.
		// Without a reload inside the helper, determineNextPhase falls through
		// to "research" and S-tier slices are told to run /tff research.
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# req");
		// 1. Snapshot the slice BEFORE classify (tier=null at this point).
		const staleSlice = must(getSlice(db, sliceId));
		expect(staleSlice.tier).toBeNull();
		// 2. Classify the slice as S in the DB.
		updateSliceTier(db, sliceId, "S");
		// 3. Helper is passed the stale snapshot, but should reload internally.
		const { pi } = fakePi();
		const suffix = buildDiscussCompletionSuffix(pi, db, root, staleSlice, 1);

		expect(suffix.isComplete).toBe(true);
		expect(suffix.text).toContain("/tff plan");
		expect(suffix.text).not.toContain("/tff research");
	});

	it("does NOT re-emit phase_complete when discuss is already completed (prevents /tff doctor LogDrift)", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# req");
		updateSliceTier(db, sliceId, "SS");
		// Pre-existing completed phase_run simulates the user revising a writer
		// tool after discuss already finished (write-spec → write-requirements →
		// classify each call this helper; duplicate emits tripped doctor).
		insertPhaseRun(db, {
			sliceId,
			phase: "discuss",
			status: "completed",
			startedAt: new Date().toISOString(),
		});
		const slice = must(getSlice(db, sliceId));
		const { pi, emit } = fakePi();

		const suffix = buildDiscussCompletionSuffix(pi, db, root, slice, 1);

		expect(suffix.isComplete).toBe(true);
		expect(suffix.text).toContain("Discuss phase complete");
		expect(emit).not.toHaveBeenCalled();
	});

	it("reports progress when SPEC + REQUIREMENTS exist but tier is unclassified", () => {
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# spec");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REQUIREMENTS.md", "# req");
		const slice = must(getSlice(db, sliceId));
		const { pi, emit } = fakePi();

		const suffix = buildDiscussCompletionSuffix(pi, db, root, slice, 1);

		expect(suffix.isComplete).toBe(false);
		expect(suffix.text).toContain("tier classification");
		expect(emit).not.toHaveBeenCalled();
	});
});
