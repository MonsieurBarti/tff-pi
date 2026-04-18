import { renameSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { appendCommand, updateLogCursor } from "./event-log.js";
import { validateCommandPreconditions } from "./preconditions.js";
import { projectCommand } from "./projection.js";

export type FsOps = () => Array<{ tmp: string; final: string }>;
export type CommitMeta = { actor?: "agent" | "user" | "system"; actor_name?: string };

export function commitCommand(
	db: Database.Database,
	root: string,
	cmd: string,
	params: Record<string, unknown>,
	fsOps?: FsOps,
	meta?: CommitMeta,
): void {
	const check = validateCommandPreconditions(db, root, cmd, params);
	if (!check.ok) {
		throw new Error(check.reason ?? `Precondition failed for '${cmd}'`);
	}

	const pending = fsOps?.() ?? [];
	const renamed = new Array<boolean>(pending.length).fill(false);

	try {
		db.transaction(() => {
			projectCommand(db, root, cmd, params);
			const { hash, row } = appendCommand(root, cmd, params, meta);
			updateLogCursor(db, hash, row);
		})();

		for (let i = 0; i < pending.length; i++) {
			const op = pending[i];
			if (op) {
				renameSync(op.tmp, op.final);
				renamed[i] = true;
			}
		}
	} finally {
		for (let i = 0; i < pending.length; i++) {
			if (!renamed[i]) {
				const op = pending[i];
				if (op) rmSync(op.tmp, { force: true });
			}
		}
	}
}
