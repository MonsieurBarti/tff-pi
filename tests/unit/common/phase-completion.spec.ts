import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updatePhaseRun,
	updateSliceTier,
} from "../../../src/common/db.js";
import {
	closePredecessorIfReady,
	emitPhaseCompleteIfArtifactsReady,
} from "../../../src/common/phase-completion.js";
import type { Phase, Slice } from "../../../src/common/types.js";
import { must } from "../../helpers.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as Parameters<typeof closePredecessorIfReady>[0];
}

function makeSlice(db: Database.Database, sliceId: string): Slice {
	const slices = getSlices(db, must(getMilestones(db, must(getProject(db)).id)[0]).id);
	const found = slices.find((s) => s.id === sliceId);
	if (!found) throw new Error("slice not found");
	return found;
}

describe("closePredecessorIfReady", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceTier(db, sliceId, "SS");
	});

	it("is a no-op when the current phase has no predecessor (discuss)", () => {
		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const predecessorFn = vi.fn((p: Phase) => (p === "discuss" ? null : null));
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		closePredecessorIfReady(pi, db, "/root", slice, "discuss", predecessorFn, verify);

		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("is a no-op when predecessor has no phase_run row", () => {
		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const predecessorFn = vi.fn().mockReturnValue("plan");
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		closePredecessorIfReady(pi, db, "/root", slice, "execute", predecessorFn, verify);

		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("is a no-op when predecessor's phase_run is already completed", () => {
		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, { status: "completed", finishedAt: new Date().toISOString() });

		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const predecessorFn = vi.fn().mockReturnValue("plan");
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		closePredecessorIfReady(pi, db, "/root", slice, "execute", predecessorFn, verify);

		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("is a no-op when predecessor artifacts are not ready", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const predecessorFn = vi.fn().mockReturnValue("plan");
		const verify = vi.fn().mockReturnValue({ ok: false, missing: ["PLAN.md"] });

		closePredecessorIfReady(pi, db, "/root", slice, "execute", predecessorFn, verify);

		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("emits phase_complete for a stalled predecessor whose artifacts ARE ready", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const predecessorFn = vi.fn().mockReturnValue("plan");
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		closePredecessorIfReady(pi, db, "/root", slice, "execute", predecessorFn, verify);

		const completeCalls = (pi.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "plan",
		);
		expect(completeCalls).toHaveLength(1);
	});

	it("handles execute → verify close-out (no artifacts required for execute)", () => {
		// Execute is the typical case: no writer tool, no verifyPhaseArtifacts case,
		// so verifyPhaseArtifacts returns ok=true.
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const predecessorFn = vi.fn().mockReturnValue("execute");
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		closePredecessorIfReady(pi, db, "/root", slice, "verify", predecessorFn, verify);

		const completeCalls = (pi.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "execute",
		);
		expect(completeCalls).toHaveLength(1);
	});
});

describe("emitPhaseCompleteIfArtifactsReady — hint return value", () => {
	let db: Database.Database;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceTier(db, sliceId, "SS");
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sliceId);
	});

	it("returns the next-phase hint when artifacts are ready", () => {
		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		const hint = emitPhaseCompleteIfArtifactsReady(pi, db, "/root", slice, "plan", verify);

		expect(hint).toBe("→ Next: /tff execute M01-S01");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("returns null when artifacts are not ready", () => {
		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const verify = vi.fn().mockReturnValue({ ok: false, missing: ["PLAN.md"] });

		const hint = emitPhaseCompleteIfArtifactsReady(pi, db, "/root", slice, "plan", verify);

		expect(hint).toBeNull();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("returns /tff complete-milestone hint when the final slice ships", () => {
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(sliceId);
		const pi = makePi();
		const slice = makeSlice(db, sliceId);
		const verify = vi.fn().mockReturnValue({ ok: true, missing: [] });

		const hint = emitPhaseCompleteIfArtifactsReady(pi, db, "/root", slice, "ship", verify);

		expect(hint).toBe("→ Next: /tff complete-milestone");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});
