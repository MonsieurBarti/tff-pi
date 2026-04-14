import type { Snapshot } from "./state-exporter.js";

export interface Conflict {
	table: string;
	id: string;
	field: string;
	base: unknown;
	ours: unknown;
	theirs: unknown;
}

export type MergeResult = { ok: true; merged: Snapshot } | { ok: false; conflicts: Conflict[] };

const TABLES = ["project", "milestone", "slice", "task", "dependency", "phase_run"] as const;
type Table = (typeof TABLES)[number];

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
	const m = new Map<string, T>();
	for (const r of rows) m.set(r.id, r);
	return m;
}

export function mergeSnapshots(base: Snapshot, ours: Snapshot, theirs: Snapshot): MergeResult {
	const conflicts: Conflict[] = [];
	const merged: Snapshot = {
		schemaVersion: ours.schemaVersion,
		exportedAt: ours.exportedAt,
		project: [],
		milestone: [],
		slice: [],
		task: [],
		dependency: [],
		phase_run: [],
	};
	for (const t of TABLES) {
		type Row = { id: string } & Record<string, unknown>;
		const b = byId(base[t] as unknown as Row[]);
		const o = byId(ours[t] as unknown as Row[]);
		const th = byId(theirs[t] as unknown as Row[]);
		const ids = new Set<string>([...o.keys(), ...th.keys()]);
		const out: Row[] = [];
		for (const id of [...ids].sort()) {
			const ro = o.get(id);
			const rt = th.get(id);
			const rb = b.get(id);
			if (!ro && rt) {
				out.push(rt);
				continue;
			}
			if (ro && !rt) {
				out.push(ro);
				continue;
			}
			if (ro && rt) {
				if (deepEqual(ro, rt)) {
					out.push(ro);
					continue;
				}
				const { row, rowConflicts } = mergeRow(t, id, rb, ro, rt);
				conflicts.push(...rowConflicts);
				out.push(row);
			}
		}
		(merged[t] as unknown[]) = out;
	}
	if (conflicts.length > 0) return { ok: false, conflicts };
	return { ok: true, merged };
}

function mergeRow(
	_table: Table,
	_id: string,
	_base: Record<string, unknown> | undefined,
	ours: { id: string } & Record<string, unknown>,
	_theirs: { id: string } & Record<string, unknown>,
): { row: { id: string } & Record<string, unknown>; rowConflicts: Conflict[] } {
	// Placeholder for Task 6 — real per-field merge logic lands next.
	return { row: ours, rowConflicts: [] };
}
