import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
	Dependency,
	Milestone,
	MilestoneStatus,
	Project,
	Slice,
	SliceStatus,
	Task,
	TaskStatus,
	Tier,
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
	return {
		id: row.id,
		milestoneId: row.milestone_id,
		number: row.number,
		title: row.title,
		status: row.status as SliceStatus,
		tier: (row.tier ?? null) as Tier | null,
		createdAt: row.created_at,
	};
}

function rowToTask(row: TaskRow): Task {
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
): void {
	db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(
		randomUUID(),
		params.name,
		params.vision,
	);
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
): void {
	db.prepare(
		"INSERT INTO milestone (id, project_id, number, name, branch) VALUES (?, ?, ?, ?, ?)",
	).run(randomUUID(), params.projectId, params.number, params.name, params.branch);
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

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

export function insertSlice(
	db: Database.Database,
	params: { milestoneId: string; number: number; title: string },
): void {
	db.prepare("INSERT INTO slice (id, milestone_id, number, title) VALUES (?, ?, ?, ?)").run(
		randomUUID(),
		params.milestoneId,
		params.number,
		params.title,
	);
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

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export function insertTask(
	db: Database.Database,
	params: { sliceId: string; number: number; title: string; wave?: number },
): void {
	db.prepare("INSERT INTO task (id, slice_id, number, title, wave) VALUES (?, ?, ?, ?, ?)").run(
		randomUUID(),
		params.sliceId,
		params.number,
		params.title,
		params.wave ?? null,
	);
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
