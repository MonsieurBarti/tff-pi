import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "../../../src/common/db.js";
import {
	milestoneBranchName,
	resolveBranchToEntity,
	sliceBranchName,
} from "../../../src/common/branch-naming.js";

describe("branch-naming", () => {
	let dbPath: string;
	let tmp: string;
	let db: Database.Database;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tff-branch-naming-"));
		dbPath = join(tmp, "state.db");
		db = openDatabase(dbPath);
		applyMigrations(db, { root: tmp });
	});

	afterEach(() => {
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("sliceBranchName returns slice/<first 8 hex of id>", () => {
		const slice = { id: "abcdef1234567890aaaaaaaaaaaaaaaa" } as { id: string };
		expect(sliceBranchName(slice)).toBe("slice/abcdef12");
	});

	it("milestoneBranchName returns milestone/<first 8 hex of id>", () => {
		const milestone = { id: "deadbeef1111222233334444555566667" } as { id: string };
		expect(milestoneBranchName(milestone)).toBe("milestone/deadbeef");
	});

	it("resolveBranchToEntity round-trips a slice", () => {
		const projectId = randomUUID();
		db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(projectId, "p", "v");
		const milestoneId = randomUUID();
		db.prepare(
			"INSERT INTO milestone (id, project_id, number, name, branch) VALUES (?, ?, ?, ?, ?)",
		).run(milestoneId, projectId, 1, "M1", "milestone/foo");
		const sliceId = randomUUID();
		db.prepare(
			"INSERT INTO slice (id, milestone_id, number, title) VALUES (?, ?, ?, ?)",
		).run(sliceId, milestoneId, 1, "first");

		const branchName = sliceBranchName({ id: sliceId } as { id: string });
		const resolved = resolveBranchToEntity(branchName, db);
		expect(resolved).toEqual({ kind: "slice", id: sliceId, label: "M01-S01" });
	});

	it("resolveBranchToEntity round-trips a milestone", () => {
		const projectId = randomUUID();
		db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(projectId, "p", "v");
		const milestoneId = randomUUID();
		db.prepare(
			"INSERT INTO milestone (id, project_id, number, name, branch) VALUES (?, ?, ?, ?, ?)",
		).run(milestoneId, projectId, 3, "M3", "milestone/foo");

		const branchName = milestoneBranchName({ id: milestoneId } as { id: string });
		const resolved = resolveBranchToEntity(branchName, db);
		expect(resolved).toEqual({ kind: "milestone", id: milestoneId, label: "M03" });
	});

	it("returns null for unrecognized branches", () => {
		expect(resolveBranchToEntity("main", db)).toBeNull();
		expect(resolveBranchToEntity("feature/foo", db)).toBeNull();
	});

	it("returns null for malformed slugs", () => {
		expect(resolveBranchToEntity("slice/zzzzzzzz", db)).toBeNull();
		expect(resolveBranchToEntity("milestone/short", db)).toBeNull();
		expect(resolveBranchToEntity("slice/abc", db)).toBeNull();
	});

	it("logs a warning when an 8-char prefix matches more than one row", () => {
		const projectId = randomUUID();
		db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run(projectId, "p", "v");
		const milestoneId = randomUUID();
		db.prepare(
			"INSERT INTO milestone (id, project_id, number, name, branch) VALUES (?, ?, ?, ?, ?)",
		).run(milestoneId, projectId, 1, "m", "x");
		const sliceA = `${"abcdef12"}aaaaaaaaaaaaaaaaaaaaaaaa`;
		const sliceB = `${"abcdef12"}bbbbbbbbbbbbbbbbbbbbbbbb`;
		db.prepare("INSERT INTO slice (id, milestone_id, number, title) VALUES (?, ?, ?, ?)").run(
			sliceA,
			milestoneId,
			1,
			"a",
		);
		db.prepare("INSERT INTO slice (id, milestone_id, number, title) VALUES (?, ?, ?, ?)").run(
			sliceB,
			milestoneId,
			2,
			"b",
		);

		const warn = console.warn;
		const calls: string[] = [];
		console.warn = (msg: string) => calls.push(msg);
		try {
			const r = resolveBranchToEntity("slice/abcdef12", db);
			expect(r).not.toBeNull();
			expect(calls.some((c) => c.includes("ambiguous"))).toBe(true);
		} finally {
			console.warn = warn;
		}
	});
});
