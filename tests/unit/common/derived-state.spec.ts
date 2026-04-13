import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { computeSliceStatus } from "../../../src/common/derived-state.js";

let db: Database.Database;
let root: string;
let sliceId: string;
let mLabel: string;
let sLabel: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "derived-state-"));
	db = openDatabase(":memory:");
	applyMigrations(db);
	const projectId = insertProject(db, { name: "p", vision: "v" });
	const milestoneId = insertMilestone(db, {
		projectId,
		number: 1,
		name: "m",
		branch: "m01",
	});
	sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
	mLabel = "M01";
	sLabel = "M01-S01";
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

describe("computeSliceStatus — rule 2 (in-flight)", () => {
	const cases: Array<[string, string]> = [
		["discuss", "discussing"],
		["research", "researching"],
		["plan", "planning"],
		["execute", "executing"],
		["verify", "verifying"],
		["review", "reviewing"],
		["ship", "shipping"],
	];

	for (const [phase, expectedStatus] of cases) {
		it(`returns '${expectedStatus}' when ${phase} phase_run is 'started'`, () => {
			insertPhaseRun(db, {
				sliceId,
				phase,
				status: "started",
				startedAt: new Date().toISOString(),
			});
			expect(computeSliceStatus(db, root, sliceId)).toBe(expectedStatus);
		});
	}

	it("treats 'retried' the same as 'started'", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "retried",
			startedAt: new Date().toISOString(),
		});
		expect(computeSliceStatus(db, root, sliceId)).toBe("executing");
	});
});

describe("computeSliceStatus — rule 7 (no phase_runs)", () => {
	it("returns 'created' when no artifacts and no phase_runs", () => {
		expect(computeSliceStatus(db, root, sliceId)).toBe("created");
	});

	it("returns 'discussing' when SPEC.md exists out-of-band", () => {
		const dir = join(root, ".tff", "milestones", mLabel, "slices", sLabel);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SPEC.md"), "spec content");
		expect(computeSliceStatus(db, root, sliceId)).toBe("discussing");
	});

	it("returns 'discussing' when REQUIREMENTS.md exists out-of-band", () => {
		const dir = join(root, ".tff", "milestones", mLabel, "slices", sLabel);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "REQUIREMENTS.md"), "req content");
		expect(computeSliceStatus(db, root, sliceId)).toBe("discussing");
	});
});
