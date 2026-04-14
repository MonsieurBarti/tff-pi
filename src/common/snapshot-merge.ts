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

/**
 * Structural equality tolerant of NaN, undefined, and key-order differences —
 * the three ways JSON.stringify-based equality silently lies. Snapshot rows
 * today hold only string|number|null, but the state branch will eventually
 * pick up numeric columns (token costs, latencies) and we want those to
 * compare correctly when a row legitimately contains NaN or Infinity.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
		return true;
	}
	if (a === null || b === null) return a === b;
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	const oa = a as Record<string, unknown>;
	const ob = b as Record<string, unknown>;
	const ka = Object.keys(oa);
	const kb = Object.keys(ob);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.hasOwn(ob, k)) return false;
		if (!deepEqual(oa[k], ob[k])) return false;
	}
	return true;
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
	// "retried" ranks above "completed": a retry means work re-started after a
	// prior completion/failure, so the retry signal supersedes. "abandoned" is
	// last because it only appears via crash recovery (recoverOrphanedPhaseRuns).
	phase_run: ["started", "completed", "retried", "abandoned"],
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
		// Intentionally do NOT write merged[f] on conflict. mergeSnapshots returns
		// `{ ok: false, conflicts }` without exposing the merged object when any
		// conflict exists, so the field stays absent. If a future refactor ever
		// exposes the partial merged row, a missing field is a louder failure
		// than a silent ours-wins.
		rowConflicts.push({ table, id, field: f, base: bo, ours: oo, theirs: to });
	}
	return { row: merged, rowConflicts };
}
