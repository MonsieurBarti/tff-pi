import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type DatabaseT from "better-sqlite3";
import { getSessionId } from "./logger.js";

export interface CommandEvent {
	v: 2;
	cmd: string;
	params: Record<string, unknown>;
	ts: string;
	hash: string;
	actor: "agent" | "user" | "system";
	actor_name?: string;
	session_id: string;
}

export function hashEvent(cmd: string, params: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify({ cmd, params })).digest("hex").slice(0, 16);
}

function logPath(root: string): string {
	return join(root, ".tff", "event-log.jsonl");
}

export function readEvents(root: string, fromRow = 0): CommandEvent[] {
	const path = logPath(root);
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf-8");
	if (raw.length === 0) return [];
	const lines = raw.split("\n").filter((l) => l.length > 0);
	return lines.slice(fromRow).map((line) => JSON.parse(line) as CommandEvent);
}

export interface AppendResult {
	hash: string;
	row: number;
}

export function appendCommand(
	root: string,
	cmd: string,
	params: Record<string, unknown>,
	meta?: { actor?: "agent" | "user" | "system"; actor_name?: string },
): AppendResult {
	const event: CommandEvent = {
		v: 2,
		cmd,
		params,
		ts: new Date().toISOString(),
		hash: hashEvent(cmd, params),
		actor: meta?.actor ?? "agent",
		session_id: getSessionId(),
	};
	if (meta?.actor_name !== undefined) event.actor_name = meta.actor_name;

	const path = logPath(root);
	const line = `${JSON.stringify(event)}\n`;
	appendFileSync(path, line);

	// fsync the file so the append is durable before we return
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}

	// Row = current line count (post-append)
	const allLines = readEvents(root);
	return { hash: event.hash, row: allLines.length };
}

export function loadCursor(db: DatabaseT.Database): { lastHash: string | null; lastRow: number } {
	const row = db.prepare("SELECT log_cursor_hash, log_cursor_row FROM project LIMIT 1").get() as
		| { log_cursor_hash: string | null; log_cursor_row: number }
		| undefined;
	if (!row) return { lastHash: null, lastRow: 0 };
	return { lastHash: row.log_cursor_hash, lastRow: row.log_cursor_row };
}

export function updateLogCursor(db: DatabaseT.Database, hash: string, row: number): void {
	db.prepare("UPDATE project SET log_cursor_hash = ?, log_cursor_row = ?").run(hash, row);
}
