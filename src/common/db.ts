import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
	type Dependency,
	MILESTONE_STATUSES,
	type Milestone,
	type MilestoneStatus,
	type Project,
	SLICE_STATUSES,
	type Slice,
	type SliceStatus,
	TASK_STATUSES,
	TIERS,
	type Task,
	type TaskStatus,
	type Tier,
} from "./types.js";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function openDatabase(path: string): Database.Database {
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	return db;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export function applyMigrations(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS project (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			vision     TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS milestone (
			id         TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES project(id),
			number     INTEGER NOT NULL,
			name       TEXT NOT NULL,
			status     TEXT NOT NULL DEFAULT 'created',
			branch     TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_milestone_project_id ON milestone(project_id);

		CREATE TABLE IF NOT EXISTS slice (
			id           TEXT PRIMARY KEY,
			milestone_id TEXT NOT NULL REFERENCES milestone(id),
			number       INTEGER NOT NULL,
			title        TEXT NOT NULL,
			status       TEXT NOT NULL DEFAULT 'created',
			tier         TEXT,
			created_at   TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_slice_milestone_id ON slice(milestone_id);
		CREATE INDEX IF NOT EXISTS idx_slice_status ON slice(status);

		CREATE TABLE IF NOT EXISTS task (
			id         TEXT PRIMARY KEY,
			slice_id   TEXT NOT NULL REFERENCES slice(id),
			number     INTEGER NOT NULL,
			title      TEXT NOT NULL,
			status     TEXT NOT NULL DEFAULT 'open',
			wave       INTEGER,
			claimed_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_task_slice_id ON task(slice_id);
		CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
		CREATE INDEX IF NOT EXISTS idx_task_wave ON task(wave);

		CREATE TABLE IF NOT EXISTS dependency (
			from_task_id TEXT NOT NULL REFERENCES task(id),
			to_task_id   TEXT NOT NULL REFERENCES task(id),
			PRIMARY KEY (from_task_id, to_task_id)
		);
	`);
	try {
		db.exec("ALTER TABLE slice ADD COLUMN pr_url TEXT");
	} catch {
		// Column already exists
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS phase_run (
			id          TEXT PRIMARY KEY,
			slice_id    TEXT NOT NULL REFERENCES slice(id),
			phase       TEXT NOT NULL,
			status      TEXT NOT NULL,
			started_at  TEXT NOT NULL,
			finished_at TEXT,
			duration_ms INTEGER,
			error       TEXT,
			feedback    TEXT,
			metadata    TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_phase_run_slice ON phase_run(slice_id);
		CREATE INDEX IF NOT EXISTS idx_phase_run_phase ON phase_run(phase);

		CREATE TABLE IF NOT EXISTS event_log (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			channel    TEXT NOT NULL,
			type       TEXT NOT NULL,
			slice_id   TEXT NOT NULL,
			payload    TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_event_log_slice ON event_log(slice_id);
		CREATE INDEX IF NOT EXISTS idx_event_log_channel ON event_log(channel);
	`);
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

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

function rowToProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		vision: row.vision,
		createdAt: row.created_at,
	};
}

function rowToMilestone(row: MilestoneRow): Milestone {
	if (!(MILESTONE_STATUSES as readonly string[]).includes(row.status)) {
		throw new Error(`Invalid milestone status in database: ${row.status}`);
	}
	return {
		id: row.id,
		projectId: row.project_id,
		number: row.number,
		name: row.name,
		status: row.status as MilestoneStatus,
		branch: row.branch,
		createdAt: row.created_at,
	};
}

function rowToSlice(row: SliceRow): Slice {
	if (!(SLICE_STATUSES as readonly string[]).includes(row.status)) {
		throw new Error(`Invalid slice status in database: ${row.status}`);
	}
	if (row.tier !== null && !(TIERS as readonly string[]).includes(row.tier)) {
		throw new Error(`Invalid tier in database: ${row.tier}`);
	}
	return {
		id: row.id,
		milestoneId: row.milestone_id,
		number: row.number,
		title: row.title,
		status: row.status as SliceStatus,
		tier: (row.tier ?? null) as Tier | null,
		prUrl: row.pr_url ?? null,
		createdAt: row.created_at,
	};
}

function rowToTask(row: TaskRow): Task {
	if (!(TASK_STATUSES as readonly string[]).includes(row.status)) {
		throw new Error(`Invalid task status in database: ${row.status}`);
	}
	return {
		id: row.id,
		sliceId: row.slice_id,
		number: row.number,
		title: row.title,
		status: row.status as TaskStatus,
		wave: row.wave ?? null,
		claimedBy: row.claimed_by ?? null,
		createdAt: row.created_at,
	};
}

function rowToDependency(row: DependencyRow): Dependency {
	return {
		fromTaskId: row.from_task_id,
		toTaskId: row.to_task_id,
	};
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export function insertProject(
	db: Database.Database,
	params: { name: string; vision: string },
): string {
	const id = randomUUID();
	db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(
		id,
		params.name,
		params.vision,
	);
	return id;
}

export function getProject(db: Database.Database): Project | null {
	const row = db.prepare("SELECT * FROM project LIMIT 1").get() as ProjectRow | undefined;
	return row ? rowToProject(row) : null;
}

// ---------------------------------------------------------------------------
// Milestone
// ---------------------------------------------------------------------------

export function insertMilestone(
	db: Database.Database,
	params: { projectId: string; number: number; name: string; branch: string },
): string {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO milestone (id, project_id, number, name, branch) VALUES (?, ?, ?, ?, ?)",
	).run(id, params.projectId, params.number, params.name, params.branch);
	return id;
}

export function getMilestones(db: Database.Database, projectId: string): Milestone[] {
	const rows = db
		.prepare("SELECT * FROM milestone WHERE project_id = ? ORDER BY number")
		.all(projectId) as MilestoneRow[];
	return rows.map(rowToMilestone);
}

export function getMilestone(db: Database.Database, id: string): Milestone | null {
	const row = db.prepare("SELECT * FROM milestone WHERE id = ?").get(id) as
		| MilestoneRow
		| undefined;
	return row ? rowToMilestone(row) : null;
}

export function updateMilestoneStatus(
	db: Database.Database,
	id: string,
	status: MilestoneStatus,
): void {
	db.prepare("UPDATE milestone SET status = ? WHERE id = ?").run(status, id);
}

export function getNextMilestoneNumber(db: Database.Database, projectId: string): number {
	const row = db
		.prepare("SELECT MAX(number) as max_num FROM milestone WHERE project_id = ?")
		.get(projectId) as { max_num: number | null } | undefined;
	return (row?.max_num ?? 0) + 1;
}

export function getActiveMilestone(db: Database.Database, projectId: string): Milestone | null {
	const row = db
		.prepare(
			"SELECT * FROM milestone WHERE project_id = ? AND status != 'closed' ORDER BY number LIMIT 1",
		)
		.get(projectId) as MilestoneRow | undefined;
	return row ? rowToMilestone(row) : null;
}

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

export function insertSlice(
	db: Database.Database,
	params: { milestoneId: string; number: number; title: string },
): string {
	const id = randomUUID();
	db.prepare("INSERT INTO slice (id, milestone_id, number, title) VALUES (?, ?, ?, ?)").run(
		id,
		params.milestoneId,
		params.number,
		params.title,
	);
	return id;
}

export function getSlices(db: Database.Database, milestoneId: string): Slice[] {
	const rows = db
		.prepare("SELECT * FROM slice WHERE milestone_id = ? ORDER BY number")
		.all(milestoneId) as SliceRow[];
	return rows.map(rowToSlice);
}

export function getSlice(db: Database.Database, id: string): Slice | null {
	const row = db.prepare("SELECT * FROM slice WHERE id = ?").get(id) as SliceRow | undefined;
	return row ? rowToSlice(row) : null;
}

export function updateSliceStatus(db: Database.Database, id: string, status: SliceStatus): void {
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(status, id);
}

export function updateSliceTier(db: Database.Database, id: string, tier: Tier): void {
	db.prepare("UPDATE slice SET tier = ? WHERE id = ?").run(tier, id);
}

export function updateSlicePrUrl(db: Database.Database, id: string, prUrl: string): void {
	db.prepare("UPDATE slice SET pr_url = ? WHERE id = ?").run(prUrl, id);
}

export function getTasksByWave(db: Database.Database, sliceId: string): Map<number, Task[]> {
	const tasks = getTasks(db, sliceId);
	const grouped = new Map<number, Task[]>();
	for (const task of tasks) {
		if (task.wave === null) continue;
		const wave = grouped.get(task.wave);
		if (wave) {
			wave.push(task);
		} else {
			grouped.set(task.wave, [task]);
		}
	}
	return grouped;
}

export function resetTasksToOpen(db: Database.Database, sliceId: string): void {
	db.prepare("UPDATE task SET status = 'open', claimed_by = NULL WHERE slice_id = ?").run(sliceId);
}

export function getNextSliceNumber(db: Database.Database, milestoneId: string): number {
	const row = db
		.prepare("SELECT MAX(number) as max_num FROM slice WHERE milestone_id = ?")
		.get(milestoneId) as { max_num: number | null } | undefined;
	return (row?.max_num ?? 0) + 1;
}

export function getActiveSlice(db: Database.Database, milestoneId: string): Slice | null {
	const row = db
		.prepare(
			"SELECT * FROM slice WHERE milestone_id = ? AND status NOT IN ('closed', 'paused') ORDER BY number LIMIT 1",
		)
		.get(milestoneId) as SliceRow | undefined;
	return row ? rowToSlice(row) : null;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export function insertTask(
	db: Database.Database,
	params: { sliceId: string; number: number; title: string; wave?: number },
): string {
	const id = randomUUID();
	db.prepare("INSERT INTO task (id, slice_id, number, title, wave) VALUES (?, ?, ?, ?, ?)").run(
		id,
		params.sliceId,
		params.number,
		params.title,
		params.wave ?? null,
	);
	return id;
}

export function getTasks(db: Database.Database, sliceId: string): Task[] {
	const rows = db
		.prepare("SELECT * FROM task WHERE slice_id = ? ORDER BY number")
		.all(sliceId) as TaskRow[];
	return rows.map(rowToTask);
}

export function getTask(db: Database.Database, id: string): Task | null {
	const row = db.prepare("SELECT * FROM task WHERE id = ?").get(id) as TaskRow | undefined;
	return row ? rowToTask(row) : null;
}

export function updateTaskStatus(
	db: Database.Database,
	id: string,
	status: TaskStatus,
	claimedBy?: string,
): void {
	db.prepare("UPDATE task SET status = ?, claimed_by = ? WHERE id = ?").run(
		status,
		claimedBy ?? null,
		id,
	);
}

export function updateTaskWave(db: Database.Database, id: string, wave: number): void {
	db.prepare("UPDATE task SET wave = ? WHERE id = ?").run(wave, id);
}

// ---------------------------------------------------------------------------
// Dependency
// ---------------------------------------------------------------------------

export function insertDependency(
	db: Database.Database,
	params: { fromTaskId: string; toTaskId: string },
): void {
	db.prepare("INSERT INTO dependency (from_task_id, to_task_id) VALUES (?, ?)").run(
		params.fromTaskId,
		params.toTaskId,
	);
}

export function getDependencies(db: Database.Database, sliceId: string): Dependency[] {
	const rows = db
		.prepare(
			`SELECT d.from_task_id, d.to_task_id
			FROM dependency d
			JOIN task t ON t.id = d.from_task_id OR t.id = d.to_task_id
			WHERE t.slice_id = ?
			GROUP BY d.from_task_id, d.to_task_id`,
		)
		.all(sliceId) as DependencyRow[];
	return rows.map(rowToDependency);
}

// ---------------------------------------------------------------------------
// PhaseRun
// ---------------------------------------------------------------------------

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

export interface PhaseRun {
	id: string;
	sliceId: string;
	phase: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	error: string | null;
	feedback: string | null;
	metadata: string | null;
	createdAt: string;
}

function rowToPhaseRun(row: PhaseRunRow): PhaseRun {
	return {
		id: row.id,
		sliceId: row.slice_id,
		phase: row.phase,
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at ?? null,
		durationMs: row.duration_ms ?? null,
		error: row.error ?? null,
		feedback: row.feedback ?? null,
		metadata: row.metadata ?? null,
		createdAt: row.created_at,
	};
}

export function insertPhaseRun(
	db: Database.Database,
	params: { sliceId: string; phase: string; status: string; startedAt: string },
): string {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO phase_run (id, slice_id, phase, status, started_at) VALUES (?, ?, ?, ?, ?)",
	).run(id, params.sliceId, params.phase, params.status, params.startedAt);
	return id;
}

export function updatePhaseRun(
	db: Database.Database,
	id: string,
	params: {
		status: string;
		finishedAt?: string;
		durationMs?: number;
		error?: string;
		feedback?: string;
		metadata?: string;
	},
): void {
	db.prepare(
		`UPDATE phase_run
		SET status = ?, finished_at = ?, duration_ms = ?, error = ?, feedback = ?, metadata = ?
		WHERE id = ?`,
	).run(
		params.status,
		params.finishedAt ?? null,
		params.durationMs ?? null,
		params.error ?? null,
		params.feedback ?? null,
		params.metadata ?? null,
		id,
	);
}

export function getPhaseRuns(db: Database.Database, sliceId: string): PhaseRun[] {
	const rows = db
		.prepare("SELECT * FROM phase_run WHERE slice_id = ? ORDER BY created_at")
		.all(sliceId) as PhaseRunRow[];
	return rows.map(rowToPhaseRun);
}

export function getLatestPhaseRun(
	db: Database.Database,
	sliceId: string,
	phase?: string,
): PhaseRun | null {
	if (phase !== undefined) {
		const row = db
			.prepare(
				"SELECT * FROM phase_run WHERE slice_id = ? AND phase = ? ORDER BY rowid DESC LIMIT 1",
			)
			.get(sliceId, phase) as PhaseRunRow | undefined;
		return row ? rowToPhaseRun(row) : null;
	}
	const row = db
		.prepare("SELECT * FROM phase_run WHERE slice_id = ? ORDER BY rowid DESC LIMIT 1")
		.get(sliceId) as PhaseRunRow | undefined;
	return row ? rowToPhaseRun(row) : null;
}

// ---------------------------------------------------------------------------
// EventLog
// ---------------------------------------------------------------------------

interface EventLogRow {
	id: number;
	channel: string;
	type: string;
	slice_id: string;
	payload: string;
	created_at: string;
}

export interface EventLogEntry {
	id: number;
	channel: string;
	type: string;
	sliceId: string;
	payload: string;
	createdAt: string;
}

function rowToEventLog(row: EventLogRow): EventLogEntry {
	return {
		id: row.id,
		channel: row.channel,
		type: row.type,
		sliceId: row.slice_id,
		payload: row.payload,
		createdAt: row.created_at,
	};
}

export function insertEventLog(
	db: Database.Database,
	params: { channel: string; type: string; sliceId: string; payload: string },
): void {
	db.prepare("INSERT INTO event_log (channel, type, slice_id, payload) VALUES (?, ?, ?, ?)").run(
		params.channel,
		params.type,
		params.sliceId,
		params.payload,
	);
}

export function getEventLog(
	db: Database.Database,
	sliceId: string,
	channel?: string,
): EventLogEntry[] {
	if (channel !== undefined) {
		const rows = db
			.prepare("SELECT * FROM event_log WHERE slice_id = ? AND channel = ? ORDER BY id")
			.all(sliceId, channel) as EventLogRow[];
		return rows.map(rowToEventLog);
	}
	const rows = db
		.prepare("SELECT * FROM event_log WHERE slice_id = ? ORDER BY id")
		.all(sliceId) as EventLogRow[];
	return rows.map(rowToEventLog);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportState(db: Database.Database): string {
	const projects = (db.prepare("SELECT * FROM project").all() as ProjectRow[]).map(rowToProject);
	const milestones = (db.prepare("SELECT * FROM milestone").all() as MilestoneRow[]).map(
		rowToMilestone,
	);
	const slices = (db.prepare("SELECT * FROM slice").all() as SliceRow[]).map(rowToSlice);
	const tasks = (db.prepare("SELECT * FROM task").all() as TaskRow[]).map(rowToTask);
	const dependencies = (db.prepare("SELECT * FROM dependency").all() as DependencyRow[]).map(
		rowToDependency,
	);

	return JSON.stringify({ projects, milestones, slices, tasks, dependencies }, null, 2);
}
