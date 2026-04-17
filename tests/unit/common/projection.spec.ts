import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
	applyMigrations,
	getLatestPhaseRun,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { getMilestone, getSlice } from "../../../src/common/db.js";
import { UnknownCommandError, projectCommand } from "../../../src/common/projection.js";

function seeded() {
	const db = new Database(":memory:");
	applyMigrations(db);
	const root = mkdtempSync(join(tmpdir(), "tff-proj-"));
	return { db, root };
}

describe("projectCommand — registry", () => {
	test("throws UnknownCommandError for unknown cmd", () => {
		const { db, root } = seeded();
		expect(() => projectCommand(db, root, "definitely-not-a-command", {})).toThrow(
			UnknownCommandError,
		);
	});
});

describe("projectCommand — simple handlers", () => {
	test("create-project inserts project row", () => {
		const { db, root } = seeded();
		projectCommand(db, root, "create-project", { id: "p1", name: "TestProj", vision: "V" });
		const row = db.prepare("SELECT * FROM project WHERE id = 'p1'").get() as {
			name: string;
			vision: string;
		};
		expect(row.name).toBe("TestProj");
		expect(row.vision).toBe("V");
	});

	test("create-milestone inserts milestone", () => {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		projectCommand(db, root, "create-milestone", {
			id: "m1",
			projectId,
			number: 1,
			name: "Foundation",
			branch: "m01-foundation",
		});
		const row = db.prepare("SELECT * FROM milestone WHERE id = 'm1'").get() as { name: string };
		expect(row.name).toBe("Foundation");
	});

	test("create-slice inserts slice", () => {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		projectCommand(db, root, "create-slice", {
			milestoneId: mId,
			number: 1,
			title: "First slice",
		});
		const slices = db.prepare("SELECT * FROM slice WHERE milestone_id = ?").all(mId) as {
			title: string;
		}[];
		expect(slices).toHaveLength(1);
		expect(slices[0]?.title).toBe("First slice");
	});

	test("write-spec is a no-op on DB (artifact-only) but still runs reconcile", () => {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		expect(() => projectCommand(db, root, "write-spec", { sliceId: sId })).not.toThrow();
	});

	test("write-requirements is a no-op on DB", () => {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		expect(() => projectCommand(db, root, "write-requirements", { sliceId: sId })).not.toThrow();
	});
});

describe("projectCommand — phase_run handlers", () => {
	function seededSlice() {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		return { db, root, sId };
	}

	test("execute-done marks the started execute phase_run as completed", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "execute", status: "started", startedAt: "t0" });
		projectCommand(db, root, "execute-done", { sliceId: sId });
		const run = getLatestPhaseRun(db, sId, "execute");
		expect(run?.status).toBe("completed");
	});

	test("write-verification marks verify phase_run as completed", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "verify", status: "started", startedAt: "t0" });
		projectCommand(db, root, "write-verification", { sliceId: sId });
		expect(getLatestPhaseRun(db, sId, "verify")?.status).toBe("completed");
	});

	test("write-review marks review phase_run as completed", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "review", status: "started", startedAt: "t0" });
		projectCommand(db, root, "write-review", { sliceId: sId });
		expect(getLatestPhaseRun(db, sId, "review")?.status).toBe("completed");
	});

	test("write-research marks research phase_run as completed", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "research", status: "started", startedAt: "t0" });
		projectCommand(db, root, "write-research", { sliceId: sId });
		expect(getLatestPhaseRun(db, sId, "research")?.status).toBe("completed");
	});

	test("write-plan marks plan phase_run as completed (tasks managed by tool, not handler)", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "plan", status: "started", startedAt: "t0" });
		projectCommand(db, root, "write-plan", { sliceId: sId });
		expect(getLatestPhaseRun(db, sId, "plan")?.status).toBe("completed");
	});

	test("phase_run handler is a no-op when no started row exists", () => {
		const { db, root, sId } = seededSlice();
		expect(() => projectCommand(db, root, "execute-done", { sliceId: sId })).not.toThrow();
		expect(getLatestPhaseRun(db, sId, "execute")).toBeNull();
	});
});

describe("projectCommand — slice mutators", () => {
	function seededSlice() {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		return { db, root, sId, mId };
	}

	test("classify sets slice tier", () => {
		const { db, root, sId } = seededSlice();
		projectCommand(db, root, "classify", { sliceId: sId, tier: "SS" });
		expect(getSlice(db, sId)?.tier).toBe("SS");
	});

	test("transition sets slice.status directly without reconcile", () => {
		const { db, root, sId } = seededSlice();
		projectCommand(db, root, "transition", { sliceId: sId, to: "verifying" });
		expect(getSlice(db, sId)?.status).toBe("verifying");
	});

	test("override-status forces slice.status via overrideSliceStatus", () => {
		const { db, root, sId } = seededSlice();
		projectCommand(db, root, "override-status", {
			sliceId: sId,
			status: "closed",
			reason: "manual",
		});
		expect(getSlice(db, sId)?.status).toBe("closed");
	});

	test("ship-merged records prUrl, closes slice, completes ship phase_run", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "ship", status: "started", startedAt: "t0" });
		projectCommand(db, root, "ship-merged", {
			sliceId: sId,
			prUrl: "https://github.com/x/y/pull/1",
		});
		const slice = getSlice(db, sId);
		expect(slice?.prUrl).toBe("https://github.com/x/y/pull/1");
		expect(slice?.status).toBe("closed");
		expect(getLatestPhaseRun(db, sId, "ship")?.status).toBe("completed");
	});

	test("ship-apply-done marks ship phase_run completed", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "ship", status: "started", startedAt: "t0" });
		projectCommand(db, root, "ship-apply-done", { sliceId: sId });
		expect(getLatestPhaseRun(db, sId, "ship")?.status).toBe("completed");
	});

	test("ship-fix marks ship phase_run failed", () => {
		const { db, root, sId } = seededSlice();
		insertPhaseRun(db, { sliceId: sId, phase: "ship", status: "started", startedAt: "t0" });
		projectCommand(db, root, "ship-fix", { sliceId: sId });
		expect(getLatestPhaseRun(db, sId, "ship")?.status).toBe("failed");
	});

	test("ship-changes is artifact-only + reconcile", () => {
		const { db, root, sId } = seededSlice();
		expect(() => projectCommand(db, root, "ship-changes", { sliceId: sId })).not.toThrow();
	});
});

describe("projectCommand — milestone mutators", () => {
	test("complete-milestone-changes transitions milestone to 'completing'", () => {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		projectCommand(db, root, "complete-milestone-changes", { milestoneId: mId });
		expect(getMilestone(db, mId)?.status).toBe("completing");
	});

	test("complete-milestone-merged closes milestone", () => {
		const { db, root } = seeded();
		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M",
			branch: "b",
		});
		db.prepare("UPDATE milestone SET status = 'completing' WHERE id = ?").run(mId);
		projectCommand(db, root, "complete-milestone-merged", { milestoneId: mId });
		expect(getMilestone(db, mId)?.status).toBe("closed");
	});
});

describe("projectCommand — state-rename", () => {
	test("state-rename is a no-op on DB in S02 (FS-side operation)", () => {
		const { db, root } = seeded();
		expect(() =>
			projectCommand(db, root, "state-rename", {
				projectId: "p1",
				oldCodeBranch: "old",
				newCodeBranch: "new",
				oldStateBranch: "tff-state/old",
				newStateBranch: "tff-state/new",
			}),
		).not.toThrow();
	});
});
