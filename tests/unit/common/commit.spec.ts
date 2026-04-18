import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { commitCommand } from "../../../src/common/commit.js";
import {
	applyMigrations,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import * as precondModule from "../../../src/common/preconditions.js";
import * as projModule from "../../../src/common/projection.js";

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tff-commit-"));
	mkdirSync(join(root, ".tff"), { recursive: true });
	return root;
}

function seeded() {
	const db = new Database(":memory:");
	applyMigrations(db);
	const root = tempRoot();
	return { db, root };
}

/** Insert project → milestone → slice and return the slice id. */
function seedSlice(db: Database.Database): string {
	const projectId = insertProject(db, { name: "P", vision: "V" });
	const milestoneId = insertMilestone(db, {
		projectId,
		number: 1,
		name: "M1",
		branch: "m1",
	});
	return insertSlice(db, { milestoneId, number: 1, title: "S1" });
}

describe("commitCommand — happy path (no fsOps)", () => {
	test("projects command, fsyncs log, advances cursor", () => {
		const { db, root } = seeded();
		const sliceId = seedSlice(db);

		commitCommand(db, root, "override-status", { sliceId, status: "discussing", reason: "r" });

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("override-status");
		expect(loadCursor(db).lastRow).toBe(1);
	});
});

describe("commitCommand — happy path (with fsOps)", () => {
	test("tmp file renamed to final, no tmp left after success", () => {
		const { db, root } = seeded();
		const sliceId = seedSlice(db);

		const tmpPath = join(root, "artifact.tmp");
		const finalPath = join(root, "artifact.txt");

		commitCommand(
			db,
			root,
			"override-status",
			{ sliceId, status: "discussing", reason: "r" },
			() => {
				writeFileSync(tmpPath, "hello");
				return [{ tmp: tmpPath, final: finalPath }];
			},
		);

		expect(existsSync(tmpPath)).toBe(false);
		expect(existsSync(finalPath)).toBe(true);
		expect(readFileSync(finalPath, "utf-8")).toBe("hello");
	});
});

describe("commitCommand — precondition failure", () => {
	test("throws without calling fsOps when precondition fails", () => {
		const { db, root } = seeded();

		vi.spyOn(precondModule, "validateCommandPreconditions").mockReturnValue({
			ok: false,
			reason: "test-precondition-failure",
		});

		let fsOpsCalled = false;
		expect(() =>
			commitCommand(db, root, "write-spec", { sliceId: "x" }, () => {
				fsOpsCalled = true;
				return [];
			}),
		).toThrow("test-precondition-failure");

		expect(fsOpsCalled).toBe(false);

		vi.restoreAllMocks();
	});
});

describe("commitCommand — fsOps failure", () => {
	test("unlinks all tmp files returned before fsOps throws", () => {
		const { db, root } = seeded();
		const sliceId = seedSlice(db);

		const tmpPath = join(root, "should-be-cleaned.tmp");
		const finalPath = join(root, "should-be-cleaned.txt");

		// fsOps writes the file, returns the list, then the transaction succeeds,
		// but we simulate a rename failure by pointing to a bad destination dir.
		// Use a separate test pattern: fsOps returns a path list pointing to
		// a missing directory so the rename (not fsOps) fails.
		expect(() =>
			commitCommand(
				db,
				root,
				"override-status",
				{ sliceId, status: "discussing", reason: "r" },
				() => {
					writeFileSync(tmpPath, "data");
					return [{ tmp: tmpPath, final: join(root, "missing-dir", "file.txt") }];
				},
			),
		).toThrow();

		// tmp cleaned up by finally after rename failure
		expect(existsSync(tmpPath)).toBe(false);
		// The event was written (transaction succeeded before rename)
		expect(readEvents(root)).toHaveLength(1);

		// Silence unused variable warning
		void finalPath;
	});
});

describe("commitCommand — projectCommand failure", () => {
	test("rolls back tx and unlinks tmp files when projectCommand throws", () => {
		const { db, root } = seeded();
		insertProject(db, { name: "P", vision: "V" });

		const tmpPath = join(root, "should-be-cleaned.tmp");

		vi.spyOn(projModule, "projectCommand").mockImplementation(() => {
			throw new Error("projection-failure");
		});

		expect(() =>
			commitCommand(
				db,
				root,
				"override-status",
				{ sliceId: "x", status: "discussing", reason: "r" },
				() => {
					writeFileSync(tmpPath, "data");
					return [{ tmp: tmpPath, final: join(root, "final.txt") }];
				},
			),
		).toThrow("projection-failure");

		expect(existsSync(tmpPath)).toBe(false);
		expect(readEvents(root)).toHaveLength(0);
		expect(loadCursor(db).lastRow).toBe(0);

		vi.restoreAllMocks();
	});
});

describe("commitCommand — rename failure mid-list", () => {
	test("does not unlink already-renamed entries, cleans remaining tmp files", () => {
		const { db, root } = seeded();
		const sliceId = seedSlice(db);

		const tmp1 = join(root, "a.tmp");
		const final1 = join(root, "a.txt");
		const tmp2 = join(root, "b.tmp");
		const finalBadDir = join(root, "missing-dir", "b.txt"); // dir doesn't exist → renameSync throws

		expect(() =>
			commitCommand(
				db,
				root,
				"override-status",
				{ sliceId, status: "discussing", reason: "r" },
				() => {
					writeFileSync(tmp1, "aaa");
					writeFileSync(tmp2, "bbb");
					return [
						{ tmp: tmp1, final: final1 },
						{ tmp: tmp2, final: finalBadDir },
					];
				},
			),
		).toThrow();

		// first rename succeeded: final1 exists, tmp1 gone
		expect(existsSync(final1)).toBe(true);
		expect(existsSync(tmp1)).toBe(false);
		// second rename failed: tmp2 cleaned up by finally
		expect(existsSync(tmp2)).toBe(false);
	});
});
