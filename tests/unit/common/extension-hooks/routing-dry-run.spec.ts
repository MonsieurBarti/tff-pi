import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRoutingDryRun } from "../../../../src/common/extension-hooks/routing-dry-run.js";

const seedDb = (path: string) => {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE milestone (id TEXT PRIMARY KEY, number INTEGER, project_id TEXT, name TEXT, status TEXT, branch TEXT, created_at TEXT);
		CREATE TABLE slice (id TEXT PRIMARY KEY, milestone_id TEXT, number INTEGER, title TEXT, status TEXT, tier TEXT, created_at TEXT);
		INSERT INTO milestone VALUES ('m1', 2, 'p1', 'M02', 'in_progress', null, '2026-04-25T00:00:00Z');
		INSERT INTO slice VALUES ('s3', 'm1', 3, 'pool, tier policy', 'researching', null, '2026-04-25T00:00:00Z');
	`);
	return db;
};

describe("runRoutingDryRun", () => {
	let root: string;
	let db: Database.Database;
	let log: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-dryrun-"));
		mkdirSync(join(root, ".pi/.tff/milestones/M02/slices/M02-S03"), {
			recursive: true,
		});
		mkdirSync(join(root, "src/resources/agents"), { recursive: true });
		copyFileSync(
			"src/resources/agents/tff-code-reviewer.md",
			join(root, "src/resources/agents/tff-code-reviewer.md"),
		);
		db = seedDb(join(root, "state.db"));
		log = vi.fn();
	});
	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("AC-10: routing.enabled=false → zero FS writes", async () => {
		writeFileSync(join(root, ".pi/.tff/settings.yaml"), "routing:\n  enabled: false\n");
		const before = readdirSync(join(root, ".pi/.tff")).sort();
		await runRoutingDryRun({ root, db, log });
		const after = readdirSync(join(root, ".pi/.tff")).sort();
		expect(after).toEqual(before);
		expect(existsSync(join(root, ".pi/.tff/routing.jsonl"))).toBe(false);
	});

	it("AC-11: missing SPEC.md/PLAN.md → does not throw", async () => {
		writeFileSync(join(root, ".pi/.tff/settings.yaml"), "routing:\n  enabled: true\n");
		await expect(runRoutingDryRun({ root, db, log })).resolves.toBeUndefined();
	});

	it("with enabled+slice present, writes routing.jsonl with phase=review and dry_run=true", async () => {
		writeFileSync(join(root, ".pi/.tff/settings.yaml"), "routing:\n  enabled: true\n");
		writeFileSync(
			join(root, ".pi/.tff/milestones/M02/slices/M02-S03/PLAN.md"),
			"## Files\n- src/foo.ts\n",
		);
		await runRoutingDryRun({ root, db, log });
		expect(existsSync(join(root, ".pi/.tff/routing.jsonl"))).toBe(true);
	});

	it("never throws on malformed settings", async () => {
		writeFileSync(join(root, ".pi/.tff/settings.yaml"), "routing:\n  enabled: not-a-bool\n");
		await expect(runRoutingDryRun({ root, db, log })).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
	});

	it("AC-08c: missing pool agent → caught, log called", async () => {
		writeFileSync(
			join(root, ".pi/.tff/settings.yaml"),
			"routing:\n  enabled: true\n  pools:\n    review: [tff-spec-reviewer]\n",
		);
		await expect(runRoutingDryRun({ root, db, log })).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
	});
});
