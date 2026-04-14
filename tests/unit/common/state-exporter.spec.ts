import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/common/db.js";
import {
	SNAPSHOT_FILENAME,
	SNAPSHOT_SCHEMA_VERSION,
	exportSnapshot,
} from "../../../src/common/state-exporter.js";

describe("exportSnapshot", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
	});
	afterEach(() => db.close());

	it("emits empty arrays and the current schemaVersion on an empty DB", () => {
		const snap = exportSnapshot(db, { now: () => new Date("2026-04-14T00:00:00Z") });
		expect(snap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
		expect(snap.exportedAt).toBe("2026-04-14T00:00:00.000Z");
		expect(snap.project).toEqual([]);
		expect(snap.milestone).toEqual([]);
		expect(snap.slice).toEqual([]);
		expect(snap.task).toEqual([]);
		expect(snap.dependency).toEqual([]);
		expect(snap.phase_run).toEqual([]);
	});

	it("exposes SNAPSHOT_FILENAME as 'state-snapshot.json'", () => {
		expect(SNAPSHOT_FILENAME).toBe("state-snapshot.json");
	});
});
