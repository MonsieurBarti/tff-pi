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
import { handleExecuteDone } from "../../../src/tools/execute-done.js";
import { must } from "../../helpers.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as Parameters<typeof handleExecuteDone>[0];
}

describe("handleExecuteDone", () => {
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
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
	});

	it("returns error for unknown sliceId", () => {
		const pi = makePi();
		const result = handleExecuteDone(pi, db, "/root", "unknown-id");
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text ?? "").toMatch(/not found/i);
	});

	it("returns error when slice is not in 'executing' status", () => {
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(sliceId);
		const pi = makePi();
		const result = handleExecuteDone(pi, db, "/root", sliceId);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text ?? "").toMatch(/planning/);
	});

	it("emits phase_complete and hint on success, returns stop message", () => {
		const pi = makePi();
		const result = handleExecuteDone(pi, db, "/root", sliceId);

		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text ?? "").toMatch(/stop/i);

		const phaseCompleteCalls = (pi.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
			([ch, e]) => ch === "tff:phase" && e.type === "phase_complete" && e.phase === "execute",
		);
		expect(phaseCompleteCalls).toHaveLength(1);

		const sendCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0]?.[0]).toBe("→ Next: /tff verify M01-S01");
	});

	it("accepts an M##-S## label as sliceId", () => {
		const pi = makePi();
		const result = handleExecuteDone(pi, db, "/root", "M01-S01");
		expect(result.isError).toBeFalsy();
	});
});
