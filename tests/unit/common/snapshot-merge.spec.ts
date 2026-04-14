import { describe, expect, it } from "vitest";
import { mergeSnapshots } from "../../../src/common/snapshot-merge.js";
import {
	SNAPSHOT_SCHEMA_VERSION,
	type Snapshot,
	serializeSnapshot,
} from "../../../src/common/state-exporter.js";

function makeSnap(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		exportedAt: "2026-04-14T00:00:00.000Z",
		project: [],
		milestone: [],
		slice: [],
		task: [],
		dependency: [],
		phase_run: [],
		...overrides,
	};
}

describe("mergeSnapshots row-level", () => {
	it("returns ok:true when base/ours/theirs are all empty", () => {
		const r = mergeSnapshots(makeSnap(), makeSnap(), makeSnap());
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.merged.project).toEqual([]);
			expect(r.merged.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
		}
	});

	it("both-add identical row — accepted once", () => {
		const row = { id: "p1", name: "P", vision: "V", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap(),
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project).toEqual([row]);
	});

	it("only-ours adds row — kept", () => {
		const row = { id: "p1", name: "P", vision: "V", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap(),
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
			makeSnap(),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project).toEqual([row]);
	});

	it("only-theirs adds row — kept", () => {
		const row = { id: "p1", name: "P", vision: "V", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap(),
			makeSnap(),
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project).toEqual([row]);
	});

	it("only-ours deletes — keeps (no deletion propagation)", () => {
		const row = { id: "p1", name: "P", vision: "V", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
			makeSnap(),
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project).toEqual([row]);
	});

	it("only-theirs deletes — keeps (no deletion propagation)", () => {
		const row = { id: "p1", name: "P", vision: "V", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
			makeSnap(),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project).toEqual([row]);
	});

	it("both-delete — omitted", () => {
		const row = { id: "p1", name: "P", vision: "V", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap({ project: [row] as unknown as Snapshot["project"] }),
			makeSnap(),
			makeSnap(),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project).toEqual([]);
	});

	it("merged arrays are sorted by id ascending", () => {
		const a = { id: "a", name: "A", vision: "", createdAt: "t" };
		const b = { id: "b", name: "B", vision: "", createdAt: "t" };
		const c = { id: "c", name: "C", vision: "", createdAt: "t" };
		const r = mergeSnapshots(
			makeSnap(),
			makeSnap({ project: [c, a] as unknown as Snapshot["project"] }),
			makeSnap({ project: [b] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.project.map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
});

describe("mergeSnapshots field-level", () => {
	const mkProj = (id: string, name = "A", vision = "V") => ({ id, name, vision, createdAt: "t" });

	it("only-ours changes field — takes ours", () => {
		const base = mkProj("p1", "A", "V");
		const ours = { ...base, name: "B" };
		const theirs = { ...base };
		const r = mergeSnapshots(
			makeSnap({ project: [base] as unknown as Snapshot["project"] }),
			makeSnap({ project: [ours] as unknown as Snapshot["project"] }),
			makeSnap({ project: [theirs] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const p = r.merged.project[0];
			expect(p).toBeDefined();
			expect(p?.name).toBe("B");
		}
	});

	it("only-theirs changes field — takes theirs", () => {
		const base = mkProj("p1", "A", "V");
		const r = mergeSnapshots(
			makeSnap({ project: [base] as unknown as Snapshot["project"] }),
			makeSnap({ project: [base] as unknown as Snapshot["project"] }),
			makeSnap({ project: [{ ...base, name: "B" }] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const p = r.merged.project[0];
			expect(p).toBeDefined();
			expect(p?.name).toBe("B");
		}
	});

	it("both change to same value — take it, no conflict", () => {
		const base = mkProj("p1", "A");
		const r = mergeSnapshots(
			makeSnap({ project: [base] as unknown as Snapshot["project"] }),
			makeSnap({ project: [{ ...base, name: "B" }] as unknown as Snapshot["project"] }),
			makeSnap({ project: [{ ...base, name: "B" }] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const p = r.merged.project[0];
			expect(p).toBeDefined();
			expect(p?.name).toBe("B");
		}
	});

	it("both change to different free-text values — conflict", () => {
		const base = mkProj("p1", "A");
		const r = mergeSnapshots(
			makeSnap({ project: [base] as unknown as Snapshot["project"] }),
			makeSnap({ project: [{ ...base, name: "B" }] as unknown as Snapshot["project"] }),
			makeSnap({ project: [{ ...base, name: "C" }] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.conflicts).toEqual([
				{ table: "project", id: "p1", field: "name", base: "A", ours: "B", theirs: "C" },
			]);
		}
	});
});

describe("mergeSnapshots status precedence", () => {
	const mkSlice = (status: string) => ({
		id: "s1",
		milestoneId: "m1",
		number: 1,
		title: "T",
		status,
		tier: null,
		prUrl: null,
		createdAt: "t",
	});
	const mkTask = (status: string) => ({
		id: "t1",
		sliceId: "s1",
		number: 1,
		title: "T",
		status,
		wave: null,
		claimedBy: null,
		createdAt: "t",
	});
	const mkMilestone = (status: string) => ({
		id: "m1",
		projectId: "p1",
		number: 1,
		name: "M",
		status,
		branch: "b",
		createdAt: "t",
	});
	const mkPhaseRun = (status: string) => ({
		id: "pr1",
		sliceId: "s1",
		phase: "plan",
		status,
		startedAt: "t",
		finishedAt: null,
		durationMs: null,
		error: null,
		feedback: null,
		metadata: null,
		createdAt: "t",
	});

	it("slice: discussing vs planning -> planning", () => {
		const r = mergeSnapshots(
			makeSnap({ slice: [mkSlice("created")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("discussing")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("planning")] as unknown as Snapshot["slice"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.slice[0]?.status).toBe("planning");
	});

	it("slice: executing vs verifying -> verifying", () => {
		const r = mergeSnapshots(
			makeSnap({ slice: [mkSlice("created")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("executing")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("verifying")] as unknown as Snapshot["slice"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.slice[0]?.status).toBe("verifying");
	});

	it("slice: reviewing vs closed -> closed", () => {
		const r = mergeSnapshots(
			makeSnap({ slice: [mkSlice("created")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("reviewing")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("closed")] as unknown as Snapshot["slice"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.slice[0]?.status).toBe("closed");
	});

	it("task: open vs in_progress -> in_progress", () => {
		const r = mergeSnapshots(
			makeSnap({ task: [mkTask("open")] as unknown as Snapshot["task"] }),
			makeSnap({ task: [mkTask("open")] as unknown as Snapshot["task"] }),
			makeSnap({ task: [mkTask("in_progress")] as unknown as Snapshot["task"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.task[0]?.status).toBe("in_progress");
	});

	it("task: in_progress vs closed -> closed", () => {
		const r = mergeSnapshots(
			makeSnap({ task: [mkTask("open")] as unknown as Snapshot["task"] }),
			makeSnap({ task: [mkTask("in_progress")] as unknown as Snapshot["task"] }),
			makeSnap({ task: [mkTask("closed")] as unknown as Snapshot["task"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.task[0]?.status).toBe("closed");
	});

	it("milestone: created vs in_progress -> in_progress", () => {
		const r = mergeSnapshots(
			makeSnap({ milestone: [mkMilestone("created")] as unknown as Snapshot["milestone"] }),
			makeSnap({ milestone: [mkMilestone("created")] as unknown as Snapshot["milestone"] }),
			makeSnap({ milestone: [mkMilestone("in_progress")] as unknown as Snapshot["milestone"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.milestone[0]?.status).toBe("in_progress");
	});

	it("phase_run: started vs completed -> completed", () => {
		const r = mergeSnapshots(
			makeSnap({ phase_run: [mkPhaseRun("started")] as unknown as Snapshot["phase_run"] }),
			makeSnap({ phase_run: [mkPhaseRun("started")] as unknown as Snapshot["phase_run"] }),
			makeSnap({ phase_run: [mkPhaseRun("completed")] as unknown as Snapshot["phase_run"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.phase_run[0]?.status).toBe("completed");
	});

	it("phase_run: completed vs failed -> failed (terminal wins)", () => {
		const r = mergeSnapshots(
			makeSnap({ phase_run: [mkPhaseRun("started")] as unknown as Snapshot["phase_run"] }),
			makeSnap({ phase_run: [mkPhaseRun("completed")] as unknown as Snapshot["phase_run"] }),
			makeSnap({ phase_run: [mkPhaseRun("failed")] as unknown as Snapshot["phase_run"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.phase_run[0]?.status).toBe("failed");
	});

	it("phase_run: failed vs failed -> failed (idempotent)", () => {
		const r = mergeSnapshots(
			makeSnap({ phase_run: [mkPhaseRun("started")] as unknown as Snapshot["phase_run"] }),
			makeSnap({ phase_run: [mkPhaseRun("failed")] as unknown as Snapshot["phase_run"] }),
			makeSnap({ phase_run: [mkPhaseRun("failed")] as unknown as Snapshot["phase_run"] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.merged.phase_run[0]?.status).toBe("failed");
	});

	it("unknown status on one side -> conflict", () => {
		const r = mergeSnapshots(
			makeSnap({ slice: [mkSlice("created")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("executing")] as unknown as Snapshot["slice"] }),
			makeSnap({ slice: [mkSlice("bogus-status")] as unknown as Snapshot["slice"] }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.conflicts[0]).toMatchObject({
				table: "slice",
				id: "s1",
				field: "status",
			});
		}
	});
});

describe("mergeSnapshots determinism", () => {
	it("serialized merge output matches a fresh export of the same logical state", () => {
		const rows = [
			{ id: "a", name: "A", vision: "V", createdAt: "t" },
			{ id: "b", name: "B", vision: "V", createdAt: "t" },
		];
		const r = mergeSnapshots(
			makeSnap(),
			makeSnap({ project: [rows[0]] as unknown as Snapshot["project"] }),
			makeSnap({ project: [rows[1]] as unknown as Snapshot["project"] }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const direct = makeSnap({ project: rows as unknown as Snapshot["project"] });
		expect(serializeSnapshot(r.merged)).toBe(serializeSnapshot(direct));
	});

	it("is commutative on non-conflicting inputs (swap ours/theirs)", () => {
		const a = { id: "a", name: "A", vision: "V", createdAt: "t" };
		const b = { id: "b", name: "B", vision: "V", createdAt: "t" };
		const r1 = mergeSnapshots(
			makeSnap(),
			makeSnap({ project: [a] as unknown as Snapshot["project"] }),
			makeSnap({ project: [b] as unknown as Snapshot["project"] }),
		);
		const r2 = mergeSnapshots(
			makeSnap(),
			makeSnap({ project: [b] as unknown as Snapshot["project"] }),
			makeSnap({ project: [a] as unknown as Snapshot["project"] }),
		);
		expect(r1.ok && r2.ok).toBe(true);
		if (r1.ok && r2.ok) {
			expect(serializeSnapshot(r1.merged)).toBe(serializeSnapshot(r2.merged));
		}
	});
});
