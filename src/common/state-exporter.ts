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

export function exportSnapshot(_db: Database.Database, opts?: { now?: () => Date }): Snapshot {
	const now = (opts?.now ?? (() => new Date()))();
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		exportedAt: now.toISOString(),
		project: [],
		milestone: [],
		slice: [],
		task: [],
		dependency: [],
		phase_run: [],
	};
}
