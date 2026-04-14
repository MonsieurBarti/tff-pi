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
				out.push(row as Row);
			}
		}
		(merged[t] as unknown[]) = out;
	}
	if (conflicts.length > 0) return { ok: false, conflicts };
	return { ok: true, merged };
}

// Mirrors the canonical status arrays in src/common/types.ts. Any future
// addition to those arrays requires a matching update here — the merge order
// is a semantics decision, not a code-ordering accident.
// slice.status is a derived-cache column (see src/common/derived-state.ts);
// merge applies this order best-effort. Post-import reconcile heals drift.
const STATUS_ORDER: Record<Table, string[]> = {
	project: [],
	milestone: ["created", "in_progress", "completing", "closed"],
	slice: [
		"created",
		"discussing",
		"researching",
		"planning",
		"executing",
		"verifying",
		"reviewing",
		"shipping",
		"closed",
	],
	task: ["open", "in_progress", "closed"],
	phase_run: ["started", "retried", "completed", "abandoned"],
	dependency: [],
};

const TERMINAL_WINS = new Set<string>(["failed"]);

function resolveStatus(table: Table, ours: string, theirs: string): string | undefined {
	if (TERMINAL_WINS.has(ours)) return ours;
	if (TERMINAL_WINS.has(theirs)) return theirs;
	const order = STATUS_ORDER[table];
	const io = order.indexOf(ours);
	const it = order.indexOf(theirs);
	if (io < 0 || it < 0) return undefined;
	return io >= it ? ours : theirs;
}

function mergeRow(
	table: Table,
	id: string,
	base: Record<string, unknown> | undefined,
	ours: Record<string, unknown>,
	theirs: Record<string, unknown>,
): { row: Record<string, unknown>; rowConflicts: Conflict[] } {
	const fieldSet = new Set<string>([...Object.keys(ours), ...Object.keys(theirs)]);
	const fields = [...fieldSet].sort();
	const merged: Record<string, unknown> = {};
	const rowConflicts: Conflict[] = [];
	for (const f of fields) {
		const bo = base?.[f];
		const oo = ours[f];
		const to = theirs[f];
		if (oo === to) {
			merged[f] = oo;
			continue;
		}
		if (base !== undefined && oo === bo) {
			merged[f] = to;
			continue;
		}
		if (base !== undefined && to === bo) {
			merged[f] = oo;
			continue;
		}
		if (
			f === "status" &&
			STATUS_ORDER[table].length > 0 &&
			typeof oo === "string" &&
			typeof to === "string"
		) {
			const resolved = resolveStatus(table, oo, to);
			if (resolved !== undefined) {
				merged[f] = resolved;
				continue;
			}
		}
		rowConflicts.push({ table, id, field: f, base: bo, ours: oo, theirs: to });
		merged[f] = oo; // keep something placeable; caller bails on conflict anyway
	}
	return { row: merged, rowConflicts };
}
