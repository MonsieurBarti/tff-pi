import { describe, expect, it } from "vitest";
import { mergeSnapshots } from "../../../src/common/snapshot-merge.js";
import { SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "../../../src/common/state-exporter.js";

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
