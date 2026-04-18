import type Database from "better-sqlite3";
import {
	clearSliceTasks,
	getLatestPhaseRun,
	insertDependency,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	insertTask,
	resetTasksToOpen,
	updateMilestoneStatus,
	updatePhaseRun,
	updateSlicePrUrl,
	updateSliceTier,
} from "./db.js";
import { overrideSliceStatus, reconcileSliceStatus } from "./derived-state.js";
import { canTransitionSlice } from "./state-machine.js";
import { SLICE_STATUSES } from "./types.js";
import type { Phase, SliceStatus, Tier } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: dispatch table needs a base type; each handler has a concrete params type
type ProjectionHandler = (db: Database.Database, root: string, params: any) => void;

export class UnknownCommandError extends Error {
	constructor(public readonly cmd: string) {
		super(`Unknown command: ${cmd}`);
		this.name = "UnknownCommandError";
	}
}

export class ProjectionIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectionIntegrityError";
	}
}

function projectCreateProject(
	db: Database.Database,
	_root: string,
	params: {
		id?: string;
		name: string;
		vision: string;
	},
): void {
	insertProject(db, params);
}

function projectCreateMilestone(
	db: Database.Database,
	_root: string,
	params: {
		id?: string;
		projectId: string;
		number: number;
		name: string;
		branch: string;
	},
): void {
	insertMilestone(db, params);
}

function projectCreateSlice(
	db: Database.Database,
	_root: string,
	params: {
		id?: string;
		milestoneId: string;
		number: number;
		title: string;
	},
): void {
	insertSlice(db, params);
}

function projectArtifactOnly(
	db: Database.Database,
	root: string,
	params: { sliceId: string },
): void {
	reconcileSliceStatus(db, root, params.sliceId);
}

function completePhaseRun(db: Database.Database, sliceId: string, phase: Phase): void {
	const run = getLatestPhaseRun(db, sliceId, phase);
	if (!run || run.status !== "started") return;
	updatePhaseRun(db, run.id, { status: "completed", finishedAt: new Date().toISOString() });
}

function projectPhaseComplete(phase: Phase): ProjectionHandler {
	return (db, root, params: { sliceId: string }) => {
		completePhaseRun(db, params.sliceId, phase);
		reconcileSliceStatus(db, root, params.sliceId);
	};
}

function projectClassify(
	db: Database.Database,
	root: string,
	params: {
		sliceId: string;
		tier: Tier;
	},
): void {
	updateSliceTier(db, params.sliceId, params.tier);
	reconcileSliceStatus(db, root, params.sliceId);
}

function projectExecuteDone(
	db: Database.Database,
	root: string,
	params: { sliceId: string },
): void {
	const open = db
		.prepare("SELECT COUNT(*) as n FROM task WHERE slice_id = ? AND status != 'closed'")
		.get(params.sliceId) as { n: number };
	if (open.n > 0) {
		throw new ProjectionIntegrityError(
			`execute-done blocked: ${open.n} open task(s) for slice ${params.sliceId}`,
		);
	}
	completePhaseRun(db, params.sliceId, "execute");
	reconcileSliceStatus(db, root, params.sliceId);
}

function projectTransition(
	db: Database.Database,
	_root: string,
	params: {
		sliceId: string;
		to: SliceStatus;
		phase?: Phase;
		startedAt?: string;
	},
): void {
	if (!(SLICE_STATUSES as readonly string[]).includes(params.to)) {
		throw new Error(`Invalid slice status in transition command: ${params.to}`);
	}
	const currentRow = db.prepare("SELECT status FROM slice WHERE id = ?").get(params.sliceId) as
		| { status: string }
		| undefined;
	if (!currentRow) {
		throw new ProjectionIntegrityError(`Slice not found: ${params.sliceId}`);
	}
	if (!(SLICE_STATUSES as readonly string[]).includes(currentRow.status)) {
		throw new ProjectionIntegrityError(`Corrupt slice status in DB: ${currentRow.status}`);
	}
	if (!canTransitionSlice(currentRow.status as SliceStatus, params.to)) {
		throw new ProjectionIntegrityError(
			`Invalid transition ${currentRow.status} → ${params.to} for slice ${params.sliceId}`,
		);
	}
	// No reconcile: transition is the authoritative override.
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(params.to, params.sliceId);
	if (params.phase && params.startedAt) {
		insertPhaseRun(db, {
			sliceId: params.sliceId,
			phase: params.phase,
			status: "started",
			startedAt: params.startedAt,
		});
	}
}

function projectShipMerged(
	db: Database.Database,
	_root: string,
	params: {
		sliceId: string;
		prUrl: string;
	},
): void {
	updateSlicePrUrl(db, params.sliceId, params.prUrl);
	overrideSliceStatus(db, params.sliceId, "closed", "ship-merged");
	completePhaseRun(db, params.sliceId, "ship");
}

function projectShipFix(db: Database.Database, root: string, params: { sliceId: string }): void {
	const run = getLatestPhaseRun(db, params.sliceId, "ship");
	if (run && run.status === "started") {
		updatePhaseRun(db, run.id, { status: "failed", finishedAt: new Date().toISOString() });
	}
	reconcileSliceStatus(db, root, params.sliceId);
}

function projectOverrideStatus(
	db: Database.Database,
	_root: string,
	params: {
		sliceId: string;
		status: SliceStatus;
		reason: string;
	},
): void {
	if (!(SLICE_STATUSES as readonly string[]).includes(params.status)) {
		throw new Error(`Invalid slice status in override-status command: ${params.status}`);
	}
	overrideSliceStatus(db, params.sliceId, params.status, params.reason);
}

function projectCompleteMilestoneChanges(
	db: Database.Database,
	_root: string,
	params: { milestoneId: string },
): void {
	updateMilestoneStatus(db, params.milestoneId, "completing");
}

function projectCompleteMilestoneMerged(
	db: Database.Database,
	_root: string,
	params: { milestoneId: string },
): void {
	updateMilestoneStatus(db, params.milestoneId, "closed");
}

function projectWritePlan(
	db: Database.Database,
	root: string,
	params: {
		sliceId: string;
		tasks: Array<{ id: string; number: number; title: string; wave?: number }>;
		dependencies: Array<{ fromTaskId: string; toTaskId: string }>;
	},
): void {
	clearSliceTasks(db, params.sliceId);
	for (const t of params.tasks) {
		const base = { id: t.id, sliceId: params.sliceId, number: t.number, title: t.title };
		insertTask(db, t.wave !== undefined ? { ...base, wave: t.wave } : base);
	}
	for (const d of params.dependencies) {
		insertDependency(db, d);
	}
	completePhaseRun(db, params.sliceId, "plan");
	reconcileSliceStatus(db, root, params.sliceId);
}

function projectReviewRejected(
	db: Database.Database,
	root: string,
	params: { sliceId: string },
): void {
	const run = getLatestPhaseRun(db, params.sliceId, "review");
	if (run && run.status === "started") {
		updatePhaseRun(db, run.id, { status: "failed", finishedAt: new Date().toISOString() });
	}
	resetTasksToOpen(db, params.sliceId);
	reconcileSliceStatus(db, root, params.sliceId);
}

function projectStateRename(_db: Database.Database, _root: string, _params: unknown): void {
	// FS-side operation; no DB projection in S02.
}

const HANDLERS: Record<string, ProjectionHandler> = {
	"create-project": projectCreateProject,
	"create-milestone": projectCreateMilestone,
	"create-slice": projectCreateSlice,
	"write-spec": projectArtifactOnly,
	"write-requirements": projectArtifactOnly,
	"write-research": projectPhaseComplete("research"),
	"write-plan": projectWritePlan,
	"write-verification": projectPhaseComplete("verify"),
	"write-review": projectPhaseComplete("review"),
	"review-rejected": projectReviewRejected,
	"execute-done": projectExecuteDone,
	classify: projectClassify,
	transition: projectTransition,
	"ship-changes": projectArtifactOnly,
	"write-pr": projectArtifactOnly,
	"ship-apply-done": projectPhaseComplete("ship"),
	"ship-merged": projectShipMerged,
	"ship-fix": projectShipFix,
	"override-status": projectOverrideStatus,
	"complete-milestone-changes": projectCompleteMilestoneChanges,
	"complete-milestone-merged": projectCompleteMilestoneMerged,
	"state-rename": projectStateRename,
};

export function projectCommand(
	db: Database.Database,
	root: string,
	cmd: string,
	params: unknown,
): void {
	const handler = HANDLERS[cmd];
	if (!handler) throw new UnknownCommandError(cmd);
	handler(db, root, params);
}
