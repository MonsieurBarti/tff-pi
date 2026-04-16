import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getEventLog,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { emitPhaseCompleteIfArtifactsReady } from "../../../src/common/phase-completion.js";
import type { Slice } from "../../../src/common/types.js";
import { must } from "../../helpers.js";

describe("emitPhaseCompleteIfArtifactsReady — missing artifact log", () => {
	let db: Database.Database;
	let slice: Slice;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		slice = must(getSlice(db, sliceId)) as Slice;
	});

	it("writes tff:warning row and warns to stderr when artifacts missing", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fakePi = {
			events: { emit: vi.fn(), on: () => () => {} },
		} as unknown as ExtensionAPI;

		const verify = () => ({
			ok: false,
			missing: ["PLAN.md", "SPEC.md"],
		});

		const result = emitPhaseCompleteIfArtifactsReady(
			fakePi,
			db,
			"/tmp/nonexistent",
			slice,
			"plan",
			verify,
		);

		expect(result).toBeNull();
		expect(fakePi.events.emit).not.toHaveBeenCalled();

		const rows = getEventLog(db, slice.id, "tff:warning");
		expect(rows.length).toBe(1);
		const row = must(rows[0]);
		const payload = JSON.parse(row.payload) as {
			reason: string;
			phase: string;
			missing: string[];
		};
		expect(payload.reason).toBe("artifacts_not_ready");
		expect(payload.phase).toBe("plan");
		expect(payload.missing).toEqual(["PLAN.md", "SPEC.md"]);
		expect(row.type).toBe("phase_complete_skipped");

		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("emits phase_complete normally when artifacts are ready", () => {
		const fakePi = {
			events: { emit: vi.fn(), on: () => () => {} },
		} as unknown as ExtensionAPI;
		const verify = () => ({ ok: true, missing: [] });

		const result = emitPhaseCompleteIfArtifactsReady(
			fakePi,
			db,
			"/tmp/nonexistent",
			slice,
			"plan",
			verify,
		);

		expect(fakePi.events.emit).toHaveBeenCalledTimes(1);
		// Hint text varies (next open slice / complete-milestone); just assert non-null.
		expect(typeof result).toBe("string");
		expect(getEventLog(db, slice.id, "tff:warning")).toEqual([]);
	});
});
