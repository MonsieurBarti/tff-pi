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
	updateSliceTier,
} from "../../../src/common/db.js";
import { emitPhaseCompleteIfArtifactsReady } from "../../../src/common/phase-completion.js";
import { must } from "../../helpers.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
}

describe("M11-S03: user-driven hints across a slice lifecycle", () => {
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

	function getSlice() {
		const milestoneId = must(getMilestones(db, must(getProject(db)).id)[0]).id;
		return must(getSlices(db, milestoneId).find((s) => s.id === sliceId));
	}

	it("returns the correct hint after each artifact-writer phase completes", () => {
		const verifyOk = vi.fn().mockReturnValue({ ok: true, missing: [] });
		const pi = makePi();
		const hints: (string | null)[] = [];

		// discuss → research (SS tier)
		db.prepare("UPDATE slice SET status = 'discussing' WHERE id = ?").run(sliceId);
		hints.push(emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "discuss", verifyOk));

		// research → plan
		db.prepare("UPDATE slice SET status = 'researching' WHERE id = ?").run(sliceId);
		hints.push(
			emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "research", verifyOk),
		);

		// plan → execute
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(sliceId);
		hints.push(emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "plan", verifyOk));

		// execute → verify (simulates tff_execute_done path)
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
		hints.push(emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "execute", verifyOk));

		// verify → review
		db.prepare("UPDATE slice SET status = 'verifying' WHERE id = ?").run(sliceId);
		hints.push(emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "verify", verifyOk));

		// review → ship
		db.prepare("UPDATE slice SET status = 'reviewing' WHERE id = ?").run(sliceId);
		hints.push(emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "review", verifyOk));

		expect(hints).toEqual([
			"→ Next: /tff research M01-S01",
			"→ Next: /tff plan M01-S01",
			"→ Next: /tff execute M01-S01",
			"→ Next: /tff verify M01-S01",
			"→ Next: /tff review M01-S01",
			"→ Next: /tff ship M01-S01",
		]);
		// The helper should no longer pipe anything through sendUserMessage;
		// the hint is returned for the caller (tool) to render.
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("returns /tff complete-milestone after the final slice ships", () => {
		db.prepare("UPDATE slice SET status = 'shipping' WHERE id = ?").run(sliceId);
		const verifyOk = vi.fn().mockReturnValue({ ok: true, missing: [] });
		const pi = makePi();
		// Close the slice to simulate the post-ship state
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(sliceId);
		const hint = emitPhaseCompleteIfArtifactsReady(pi, db, "/root", getSlice(), "ship", verifyOk);
		expect(hint).toBe("→ Next: /tff complete-milestone");
	});
});
