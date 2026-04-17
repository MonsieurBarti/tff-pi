// Compose and resolve TFF-domain git branch names (`slice/<8hex>` and
// `milestone/<8hex>`) against entities in the SQLite store.
// For raw branch-name string validation (allow-list, traversal rejection),
// see ./branch-names.ts.

import type Database from "better-sqlite3";
import { logWarning } from "./logger.js";
import { type Milestone, type Slice, milestoneLabel, sliceLabel } from "./types.js";

const SLUG_LEN = 8;
const SLUG_RE = /^[0-9a-f]{8}$/;

export type SliceBranchInput = Pick<Slice, "id">;
export type MilestoneBranchInput = Pick<Milestone, "id">;

export function sliceBranchName(slice: SliceBranchInput): string {
	return `slice/${slice.id.slice(0, SLUG_LEN)}`;
}

export function milestoneBranchName(milestone: MilestoneBranchInput): string {
	return `milestone/${milestone.id.slice(0, SLUG_LEN)}`;
}

export interface ResolvedBranch {
	kind: "slice" | "milestone";
	id: string;
	label: string;
}

interface SliceRowPartial {
	id: string;
	milestone_id: string;
	number: number;
}

interface MilestoneRowPartial {
	id: string;
	number: number;
}

function warnIfAmbiguous(
	db: Database.Database,
	table: "slice" | "milestone",
	prefix: string,
): void {
	const count = db
		.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE id LIKE ? || '%'`)
		.get(prefix) as { c: number };
	if (count.c > 1) {
		logWarning("artifact", "ambiguous-prefix", { id: prefix, count: count.c });
	}
}

export function resolveBranchToEntity(
	branchName: string,
	db: Database.Database,
): ResolvedBranch | null {
	const sliceMatch = /^slice\/([0-9a-f]{8})$/.exec(branchName);
	if (sliceMatch) {
		const prefix = sliceMatch[1] ?? "";
		if (!SLUG_RE.test(prefix)) return null;
		const sliceRow = db
			.prepare("SELECT id, milestone_id, number FROM slice WHERE id LIKE ? || '%' LIMIT 1")
			.get(prefix) as SliceRowPartial | undefined;
		if (!sliceRow) return null;
		const mRow = db
			.prepare("SELECT number FROM milestone WHERE id = ?")
			.get(sliceRow.milestone_id) as { number: number } | undefined;
		if (!mRow) return null;
		warnIfAmbiguous(db, "slice", prefix);
		return {
			kind: "slice",
			id: sliceRow.id,
			label: sliceLabel(mRow.number, sliceRow.number),
		};
	}
	const mMatch = /^milestone\/([0-9a-f]{8})$/.exec(branchName);
	if (mMatch) {
		const prefix = mMatch[1] ?? "";
		if (!SLUG_RE.test(prefix)) return null;
		const row = db
			.prepare("SELECT id, number FROM milestone WHERE id LIKE ? || '%' LIMIT 1")
			.get(prefix) as MilestoneRowPartial | undefined;
		if (!row) return null;
		warnIfAmbiguous(db, "milestone", prefix);
		return {
			kind: "milestone",
			id: row.id,
			label: milestoneLabel(row.number),
		};
	}
	return null;
}
