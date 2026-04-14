import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { PhaseRun } from "./db.js";
import type { Dependency, Milestone, Project, Slice, Task } from "./types.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_FILENAME = "state-snapshot.json";

export class SnapshotSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotSchemaError";
	}
}

export interface SnapshotDependency extends Dependency {
	id: string; // synthesized: `${fromTaskId}:${toTaskId}`
}

export interface Snapshot {
	schemaVersion: number;
	exportedAt: string;
	project: Project[];
	milestone: Milestone[];
	slice: Slice[];
	task: Task[];
	dependency: SnapshotDependency[];
	phase_run: PhaseRun[];
}

interface ProjectRow {
	id: string;
	name: string;
	vision: string;
	created_at: string;
}
interface MilestoneRow {
	id: string;
	project_id: string;
	number: number;
	name: string;
	status: string;
	branch: string;
	created_at: string;
}
interface SliceRow {
	id: string;
	milestone_id: string;
	number: number;
	title: string;
	status: string;
	tier: string | null;
	pr_url: string | null;
	created_at: string;
}
interface TaskRow {
	id: string;
	slice_id: string;
	number: number;
	title: string;
	status: string;
	wave: number | null;
	claimed_by: string | null;
	created_at: string;
}
interface DependencyRow {
	from_task_id: string;
	to_task_id: string;
}
interface PhaseRunRow {
	id: string;
	slice_id: string;
	phase: string;
	status: string;
	started_at: string;
	finished_at: string | null;
	duration_ms: number | null;
	error: string | null;
	feedback: string | null;
	metadata: string | null;
	created_at: string;
}

function toProject(r: ProjectRow): Project {
	return { id: r.id, name: r.name, vision: r.vision, createdAt: r.created_at };
}
function toMilestone(r: MilestoneRow): Milestone {
	return {
		id: r.id,
		projectId: r.project_id,
		number: r.number,
		name: r.name,
		status: r.status as Milestone["status"],
		branch: r.branch,
		createdAt: r.created_at,
	};
}
function toSlice(r: SliceRow): Slice {
	return {
		id: r.id,
		milestoneId: r.milestone_id,
		number: r.number,
		title: r.title,
		status: r.status as Slice["status"],
		tier: (r.tier ?? null) as Slice["tier"],
		prUrl: r.pr_url ?? null,
		createdAt: r.created_at,
	};
}
function toTask(r: TaskRow): Task {
	return {
		id: r.id,
		sliceId: r.slice_id,
		number: r.number,
		title: r.title,
		status: r.status as Task["status"],
		wave: r.wave ?? null,
		claimedBy: r.claimed_by ?? null,
		createdAt: r.created_at,
	};
}
function toDependency(r: DependencyRow): SnapshotDependency {
	return {
		id: `${r.from_task_id}:${r.to_task_id}`,
		fromTaskId: r.from_task_id,
		toTaskId: r.to_task_id,
	};
}
// SECURITY NOTE — free-text fields in phase_run.
//   `error`, `feedback`, and `metadata` are populated from LLM outputs, shell
//   errors, tool results, and structured phase payloads. They are NOT filtered
//   and MAY contain secrets (API keys pasted into error traces, user-supplied
//   credentials from a failed tool call, stack traces citing file paths that
//   expose username/hostname, etc.).
//
//   Once this snapshot is committed to a state branch (M10-S03) and pushed to
//   a remote, any such content becomes part of the git history and is visible
//   to anyone with pull access. TFF's trust boundary here is identical to the
//   code branch (a shared push-access remote), so the assumption is: whoever
//   can read code can read snapshots. If that assumption shifts — e.g., public
//   state branches, or tighter separation from code — revisit by either
//   redacting these fields at export time or encrypting the snapshot.
function toPhaseRun(r: PhaseRunRow): PhaseRun {
	return {
		id: r.id,
		sliceId: r.slice_id,
		phase: r.phase,
		status: r.status,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		durationMs: r.duration_ms,
		error: r.error,
		feedback: r.feedback,
		metadata: r.metadata,
		createdAt: r.created_at,
	};
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
	return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function exportSnapshot(db: Database.Database, opts?: { now?: () => Date }): Snapshot {
	const now = (opts?.now ?? (() => new Date()))();
	const project = sortById(
		(db.prepare("SELECT * FROM project").all() as ProjectRow[]).map(toProject),
	);
	const milestone = sortById(
		(db.prepare("SELECT * FROM milestone").all() as MilestoneRow[]).map(toMilestone),
	);
	const slice = sortById((db.prepare("SELECT * FROM slice").all() as SliceRow[]).map(toSlice));
	const task = sortById((db.prepare("SELECT * FROM task").all() as TaskRow[]).map(toTask));
	const dependency = sortById(
		(db.prepare("SELECT * FROM dependency").all() as DependencyRow[]).map(toDependency),
	);
	const phase_run = sortById(
		(db.prepare("SELECT * FROM phase_run").all() as PhaseRunRow[]).map(toPhaseRun),
	);
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		exportedAt: now.toISOString(),
		project,
		milestone,
		slice,
		task,
		dependency,
		phase_run,
	};
}

export function sortedKeysReplacer(_key: string, value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
		return sorted;
	}
	return value;
}

export function serializeSnapshot(snap: Snapshot): string {
	return `${JSON.stringify(snap, sortedKeysReplacer, 2)}\n`;
}

/**
 * Atomic write of the serialized snapshot. Writes to a sibling `.tmp` file and
 * renames — POSIX rename is atomic on the same filesystem, so a crash mid-write
 * leaves the original intact rather than a truncated JSON that breaks readers.
 */
export function writeSnapshot(db: Database.Database, homeDir: string): string {
	const path = join(homeDir, SNAPSHOT_FILENAME);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, serializeSnapshot(exportSnapshot(db)), "utf-8");
	renameSync(tmp, path);
	return path;
}

export function readSnapshot(path: string): Snapshot {
	const raw = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new SnapshotSchemaError(`state-snapshot.json is not valid JSON: ${(e as Error).message}`);
	}
	const obj = parsed as Partial<Snapshot>;
	if (obj.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new SnapshotSchemaError(
			`state-snapshot.json schema v${obj.schemaVersion} not supported by this TFF build (v${SNAPSHOT_SCHEMA_VERSION}). Update TFF to a version that supports schema v${obj.schemaVersion}, or delete state-snapshot.json to regenerate from the current DB.`,
		);
	}
	return obj as Snapshot;
}
