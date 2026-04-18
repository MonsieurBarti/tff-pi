import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getLatestPhaseRun, getMilestone, getSlice } from "./db.js";
import { canTransitionSlice } from "./state-machine.js";
import type { Phase, SliceStatus } from "./types.js";
import { milestoneLabel, sliceLabel } from "./types.js";

export interface PreconditionResult {
	ok: boolean;
	reason?: string;
}

function ok(): PreconditionResult {
	return { ok: true };
}

function fail(reason: string): PreconditionResult {
	return { ok: false, reason };
}

type Checker = (db: Database.Database, root: string, params: unknown) => PreconditionResult;

function sliceId(params: unknown): string | undefined {
	return (params as { sliceId?: string }).sliceId;
}

function milestoneId(params: unknown): string | undefined {
	return (params as { milestoneId?: string }).milestoneId;
}

function checkSliceStatus(
	db: Database.Database,
	params: unknown,
	expected: SliceStatus,
): PreconditionResult {
	const id = sliceId(params);
	if (!id) return fail("params.sliceId missing");
	const slice = getSlice(db, id);
	if (!slice) return fail(`Slice not found: ${id}`);
	if (slice.status !== expected) {
		return fail(`Slice must be in '${expected}' (current: '${slice.status}')`);
	}
	return ok();
}

function checkPhaseRun(db: Database.Database, params: unknown, phase: Phase): PreconditionResult {
	const id = sliceId(params);
	if (!id) return fail("params.sliceId missing");
	const run = getLatestPhaseRun(db, id, phase);
	if (!run || run.status !== "started") {
		return fail(`'${phase}' phase_run must be in 'started' (found: '${run?.status ?? "none"}')`);
	}
	return ok();
}

function checkTasksClosed(db: Database.Database, params: unknown): PreconditionResult {
	const id = sliceId(params);
	if (!id) return fail("params.sliceId missing");
	const row = db
		.prepare("SELECT COUNT(*) as n FROM task WHERE slice_id = ? AND status != 'closed'")
		.get(id) as { n: number };
	if (row.n > 0) return fail(`${row.n} open task(s) — all must be closed`);
	return ok();
}

function checkSliceAndPhaseAndTasks(status: SliceStatus, phase: Phase): Checker {
	return (db, _root, params) => {
		const s = checkSliceStatus(db, params, status);
		if (!s.ok) return s;
		const p = checkPhaseRun(db, params, phase);
		if (!p.ok) return p;
		return checkTasksClosed(db, params);
	};
}

function checkSliceAndPhase(status: SliceStatus, phase: Phase): Checker {
	return (db, _root, params) => {
		const s = checkSliceStatus(db, params, status);
		if (!s.ok) return s;
		return checkPhaseRun(db, params, phase);
	};
}

const CHECKERS: Record<string, Checker> = {
	"write-spec": (db, _root, params) => checkSliceStatus(db, params, "discussing"),

	"write-requirements": (db, _root, params) => {
		const id = sliceId(params);
		if (!id) return fail("params.sliceId missing");
		const slice = getSlice(db, id);
		if (!slice) return fail(`Slice not found: ${id}`);
		if (slice.status === "created" || slice.status === "shipping" || slice.status === "closed") {
			return fail(
				`Slice must not be in 'created', 'shipping', or 'closed' (current: '${slice.status}')`,
			);
		}
		return ok();
	},

	"write-research": checkSliceAndPhase("researching", "research"),
	"write-plan": checkSliceAndPhase("planning", "plan"),
	"execute-done": checkSliceAndPhaseAndTasks("executing", "execute"),
	"write-verification": checkSliceAndPhaseAndTasks("verifying", "verify"),
	"write-review": checkSliceAndPhaseAndTasks("reviewing", "review"),
	"ship-changes": checkSliceAndPhaseAndTasks("shipping", "ship"),
	"ship-apply-done": checkSliceAndPhaseAndTasks("shipping", "ship"),
	"ship-merged": checkSliceAndPhaseAndTasks("shipping", "ship"),
	"ship-fix": checkSliceAndPhase("shipping", "ship"),

	classify: (db, root, params) => {
		const id = sliceId(params);
		if (!id) return fail("params.sliceId missing");
		const slice = getSlice(db, id);
		if (!slice) return fail(`Slice not found: ${id}`);
		if (slice.status !== "discussing") {
			return fail(`Slice must be in 'discussing' (current: '${slice.status}')`);
		}
		const milestone = getMilestone(db, slice.milestoneId);
		if (!milestone) return fail(`Milestone not found: ${slice.milestoneId}`);
		const mLabel = milestoneLabel(milestone.number);
		const sLabel = sliceLabel(milestone.number, slice.number);
		const specPath = join(root, "milestones", mLabel, "slices", sLabel, "SPEC.md");
		if (!existsSync(specPath)) return fail("SPEC.md missing for slice");
		return ok();
	},

	transition: (db, _root, params) => {
		const p = params as { sliceId?: string; to?: SliceStatus };
		if (!p.sliceId) return fail("params.sliceId missing");
		if (!p.to) return fail("params.to missing");
		const slice = getSlice(db, p.sliceId);
		if (!slice) return fail(`Slice not found: ${p.sliceId}`);
		if (!canTransitionSlice(slice.status, p.to)) {
			return fail(`Invalid transition '${slice.status}' → '${p.to}'`);
		}
		if (p.to === "verifying") {
			return checkTasksClosed(db, params);
		}
		return ok();
	},

	"complete-milestone-changes": (db, _root, params) => {
		const id = milestoneId(params);
		if (!id) return fail("params.milestoneId missing");
		const milestone = getMilestone(db, id);
		if (!milestone) return fail(`Milestone not found: ${id}`);
		if (milestone.status === "completing" || milestone.status === "closed") {
			return fail(
				`Milestone must not be in 'completing' or 'closed' (current: '${milestone.status}')`,
			);
		}
		return ok();
	},

	"complete-milestone-merged": (db, _root, params) => {
		const id = milestoneId(params);
		if (!id) return fail("params.milestoneId missing");
		const milestone = getMilestone(db, id);
		if (!milestone) return fail(`Milestone not found: ${id}`);
		if (milestone.status !== "completing") {
			return fail(`Milestone must be in 'completing' (current: '${milestone.status}')`);
		}
		return ok();
	},

	"create-project": (db, _root, _params) => {
		const existing = db.prepare("SELECT id FROM project LIMIT 1").get();
		if (existing) return fail("Project already exists");
		return ok();
	},

	"create-milestone": (db, _root, params) => {
		const p = params as { projectId?: string };
		if (!p.projectId) return fail("params.projectId missing");
		const existing = db.prepare("SELECT id FROM project WHERE id = ?").get(p.projectId);
		if (!existing) return fail(`Project not found: ${p.projectId}`);
		return ok();
	},

	"create-slice": (db, _root, params) => {
		const id = milestoneId(params);
		if (!id) return fail("params.milestoneId missing");
		const milestone = getMilestone(db, id);
		if (!milestone) return fail(`Milestone not found: ${id}`);
		return ok();
	},
};

const UNCONDITIONAL = new Set(["state-rename", "override-status", "review-rejected"]);

export function validateCommandPreconditions(
	db: Database.Database,
	root: string,
	cmd: string,
	params: unknown,
): PreconditionResult {
	if (UNCONDITIONAL.has(cmd)) return ok();
	const checker = CHECKERS[cmd];
	if (!checker) return ok();
	return checker(db, root, params);
}
