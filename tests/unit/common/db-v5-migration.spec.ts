import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../../src/common/db.js";

describe("schema v5 migration", () => {
	it("adds log_cursor columns to project and drops event_log", () => {
		const db: Database.Database = openDatabase(":memory:");
		applyMigrations(db);

		const projectCols = db.prepare("PRAGMA table_info(project)").all() as { name: string }[];
		const colNames = projectCols.map((c) => c.name);
		expect(colNames).toContain("log_cursor_hash");
		expect(colNames).toContain("log_cursor_row");

		const eventLogExists = db
			.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='event_log'")
			.get() as { n: number };
		expect(eventLogExists.n).toBe(0);

		const version = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
			v: number;
		};
		expect(version.v).toBe(5);
	});

	it("log_cursor_row defaults to 0 on fresh project", () => {
		const db: Database.Database = openDatabase(":memory:");
		applyMigrations(db);
		db.prepare("INSERT INTO project (id, name, vision) VALUES ('p1', 'n', 'v')").run();
		const row = db
			.prepare("SELECT log_cursor_hash, log_cursor_row FROM project WHERE id = 'p1'")
			.get() as { log_cursor_hash: string | null; log_cursor_row: number };
		expect(row.log_cursor_hash).toBeNull();
		expect(row.log_cursor_row).toBe(0);
	});
});
