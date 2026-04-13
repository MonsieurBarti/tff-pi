import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updatePhaseRun,
	updateSlicePrUrl,
} from "../../../src/common/db.js";
import {
	computeSliceStatus,
	overrideSliceStatus,
	reconcileSliceStatus,
} from "../../../src/common/derived-state.js";

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

describe("computeSliceStatus — rule 1 (closed)", () => {
	it("returns 'closed' when ship is completed AND pr_url is set", () => {
		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, { status: "completed", finishedAt: new Date().toISOString() });
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/1");
		expect(computeSliceStatus(db, root, sliceId)).toBe("closed");
	});

	it("returns 'shipping' when ship completed but pr_url is null", () => {
		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, { status: "completed", finishedAt: new Date().toISOString() });
		expect(computeSliceStatus(db, root, sliceId)).toBe("shipping");
	});

	it("does NOT return 'closed' when pr_url is set but ship is not completed", () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/1");
		insertPhaseRun(db, {
			sliceId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		expect(computeSliceStatus(db, root, sliceId)).toBe("shipping");
	});
});

describe("computeSliceStatus — rule 3 (rolled back)", () => {
	it("returns 'executing' when verify phase_run is 'failed'", () => {
		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "verify",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, { status: "failed", finishedAt: new Date().toISOString() });
		expect(computeSliceStatus(db, root, sliceId)).toBe("executing");
	});

	it("returns 'executing' when review phase_run is 'failed'", () => {
		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "review",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, { status: "failed", finishedAt: new Date().toISOString() });
		expect(computeSliceStatus(db, root, sliceId)).toBe("executing");
	});

	it("returns 'executing' when ship phase_run is 'failed'", () => {
		const runId = insertPhaseRun(db, {
			sliceId,
			phase: "ship",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		updatePhaseRun(db, runId, { status: "failed", finishedAt: new Date().toISOString() });
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

function writeSliceArtifact(name: string, content = "content"): void {
	const dir = join(root, ".tff", "milestones", mLabel, "slices", sLabel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), content);
}

function completePhase(phase: string): void {
	const runId = insertPhaseRun(db, {
		sliceId,
		phase,
		status: "started",
		startedAt: new Date().toISOString(),
	});
	updatePhaseRun(db, runId, { status: "completed", finishedAt: new Date().toISOString() });
}

describe("computeSliceStatus — rule 4 (completed-waiting)", () => {
	it("returns 'researching' when discuss completed + SPEC.md + REQUIREMENTS.md + tier set", () => {
		writeSliceArtifact("SPEC.md");
		writeSliceArtifact("REQUIREMENTS.md");
		db.prepare("UPDATE slice SET tier = 'SS' WHERE id = ?").run(sliceId);
		completePhase("discuss");
		expect(computeSliceStatus(db, root, sliceId)).toBe("researching");
	});

	it("returns 'discussing' when discuss completed but SPEC.md is missing (walks back)", () => {
		db.prepare("UPDATE slice SET tier = 'SS' WHERE id = ?").run(sliceId);
		completePhase("discuss");
		expect(computeSliceStatus(db, root, sliceId)).toBe("discussing");
	});

	it("returns 'executing' when plan completed + PLAN.md present", () => {
		writeSliceArtifact("SPEC.md");
		writeSliceArtifact("REQUIREMENTS.md");
		writeSliceArtifact("PLAN.md");
		db.prepare("UPDATE slice SET tier = 'S' WHERE id = ?").run(sliceId);
		completePhase("discuss");
		completePhase("plan");
		expect(computeSliceStatus(db, root, sliceId)).toBe("executing");
	});
});

describe("computeSliceStatus — rule 5 (ship-fix ignored)", () => {
	it("ignores ship-fix when computing status", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date(Date.now() - 60000).toISOString(),
		});
		insertPhaseRun(db, {
			sliceId,
			phase: "ship-fix",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		expect(computeSliceStatus(db, root, sliceId)).toBe("executing");
	});
});

describe("computeSliceStatus — rule 6 (abandoned filtered)", () => {
	it("ignores abandoned phase_run rows", () => {
		const staleId = insertPhaseRun(db, {
			sliceId,
			phase: "execute",
			status: "started",
			startedAt: new Date(Date.now() - 120000).toISOString(),
		});
		updatePhaseRun(db, staleId, { status: "abandoned" });
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		expect(computeSliceStatus(db, root, sliceId)).toBe("planning");
	});
});

describe("reconcileSliceStatus", () => {
	it("writes the computed value to slice.status and returns it", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		const result = reconcileSliceStatus(db, root, sliceId);
		expect(result.status).toBe("planning");
		expect(getSlice(db, sliceId)?.status).toBe("planning");
	});

	it("is a no-op when computed equals current cache", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(sliceId);
		const result = reconcileSliceStatus(db, root, sliceId);
		expect(result.status).toBe("planning");
	});

	it("throws if the slice does not exist", () => {
		expect(() => reconcileSliceStatus(db, root, "nope")).toThrow();
	});
});

describe("overrideSliceStatus", () => {
	it("writes the status directly to the cache column", () => {
		overrideSliceStatus(db, sliceId, "closed", "milestone-close");
		expect(getSlice(db, sliceId)?.status).toBe("closed");
	});

	it("throws if the slice does not exist", () => {
		expect(() => overrideSliceStatus(db, "nope", "closed", "r")).toThrow();
	});
});
