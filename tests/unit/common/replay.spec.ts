import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { hashEvent, loadCursor, updateLogCursor } from "../../../src/common/event-log.js";
import * as logger from "../../../src/common/logger.js";
import * as projModule from "../../../src/common/projection.js";
import { tailReplay } from "../../../src/common/replay.js";

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tff-replay-"));
	mkdirSync(join(root, ".tff"), { recursive: true });
	return root;
}

function seeded() {
	const db = new Database(":memory:");
	applyMigrations(db);
	const root = tempRoot();
	return { db, root };
}

function forceStatus(db: Database.Database, sliceId: string, status: string): void {
	db.prepare("UPDATE slice SET status = ? WHERE id = ?").run(status, sliceId);
}

function writeRawEvent(root: string, cmd: string, params: Record<string, unknown>): void {
	const event = {
		v: 2,
		cmd,
		params,
		ts: new Date().toISOString(),
		hash: hashEvent(cmd, params),
		actor: "agent",
		session_id: "test-session",
	};
	appendFileSync(join(root, ".tff", "event-log.jsonl"), `${JSON.stringify(event)}\n`);
}

describe("tailReplay — basic catch-up", () => {
	test("projects N tail events and lands cursor at correct row", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });

		const targets = ["discussing", "researching", "planning", "executing", "verifying"] as const;
		for (const target of targets) {
			writeRawEvent(root, "override-status", {
				sliceId: sId,
				status: target,
				reason: "replay-test",
			});
		}

		tailReplay(db, root);

		expect(loadCursor(db).lastRow).toBe(5);
		expect(getSlice(db, sId)?.status).toBe("verifying");
	});
});

describe("tailReplay — no-op paths", () => {
	test("is a no-op when cursor is already at EOF", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });

		writeRawEvent(root, "override-status", { sliceId: sId, status: "discussing", reason: "r" });
		const hash = hashEvent("override-status", { sliceId: sId, status: "discussing", reason: "r" });
		updateLogCursor(db, hash, 1);

		tailReplay(db, root);

		expect(loadCursor(db).lastRow).toBe(1);
	});

	test("second run is a no-op after first run catches up", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });

		writeRawEvent(root, "override-status", { sliceId: sId, status: "discussing", reason: "r" });

		tailReplay(db, root);
		const after1 = loadCursor(db).lastRow;
		tailReplay(db, root);
		const after2 = loadCursor(db).lastRow;

		expect(after1).toBe(1);
		expect(after2).toBe(1);
	});
});

describe("tailReplay — invariant violation", () => {
	test("warns and advances cursor without projecting the bad event", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });
		forceStatus(db, sId, "planning");

		writeRawEvent(root, "write-verification", { sliceId: sId });

		const warnSpy = vi.spyOn(logger, "logWarning");
		tailReplay(db, root);

		expect(loadCursor(db).lastRow).toBe(1);
		expect(warnSpy.mock.calls.some(([c, m]) => c === "replay" && m === "invariant-violation")).toBe(
			true,
		);
		expect(getSlice(db, sId)?.status).toBe("planning");
		warnSpy.mockRestore();
	});
});

describe("tailReplay — cursor integrity check", () => {
	test("emits logError when stored cursor hash does not match event at that row", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });

		writeRawEvent(root, "override-status", { sliceId: sId, status: "discussing", reason: "r" });
		updateLogCursor(db, "aaaa1111aaaa1111", 1); // wrong hash

		const errorSpy = vi.spyOn(logger, "logError");
		tailReplay(db, root);

		expect(
			errorSpy.mock.calls.some(([c, m]) => c === "replay" && m === "cursor-hash-mismatch"),
		).toBe(true);
		expect(loadCursor(db).lastRow).toBe(1);
		errorSpy.mockRestore();
	});
});

describe("tailReplay — unknown command", () => {
	test("warns and advances cursor for an unrecognized command", () => {
		const { db, root } = seeded();
		insertProject(db, { name: "P", vision: "V" });
		writeRawEvent(root, "future-command-v99", { someParam: "x" });

		const warnSpy = vi.spyOn(logger, "logWarning");
		tailReplay(db, root);

		expect(loadCursor(db).lastRow).toBe(1);
		expect(warnSpy.mock.calls.some(([c, m]) => c === "replay" && m === "unknown-command")).toBe(
			true,
		);
		warnSpy.mockRestore();
	});
});

describe("tailReplay — projection error", () => {
	test("logs error and advances cursor when projection throws, then continues with remaining events", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });

		// All 3 use override-status (unconditional precondition = always ok)
		writeRawEvent(root, "override-status", { sliceId: sId, status: "discussing", reason: "r1" });
		writeRawEvent(root, "override-status", { sliceId: sId, status: "researching", reason: "bad" });
		writeRawEvent(root, "override-status", { sliceId: sId, status: "planning", reason: "r3" });

		const errorSpy = vi.spyOn(logger, "logError");

		// Make the 2nd call to projectCommand throw (precondition passes since override-status is unconditional)
		const origProjectCommand = projModule.projectCommand;
		let n = 0;
		vi.spyOn(projModule, "projectCommand").mockImplementation((...args) => {
			n++;
			if (n === 2) throw new Error("simulated-projection-failure");
			return origProjectCommand(...(args as Parameters<typeof origProjectCommand>));
		});

		tailReplay(db, root);

		expect(loadCursor(db).lastRow).toBe(3);
		expect(errorSpy.mock.calls.some(([c, m]) => c === "replay" && m === "projection-failed")).toBe(
			true,
		);
		// Events 1 and 3 projected: discussing → [bad skipped] → planning
		expect(getSlice(db, sId)?.status).toBe("planning");

		vi.restoreAllMocks();
	});
});

describe("tailReplay — malformed log line", () => {
	test("skips a corrupted line and continues with subsequent events", () => {
		const { db, root } = seeded();
		const pId = insertProject(db, { name: "P", vision: "V" });
		const mId = insertMilestone(db, { projectId: pId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S" });

		const logPath = join(root, ".tff", "event-log.jsonl");
		const e1 = {
			v: 2,
			cmd: "override-status",
			params: { sliceId: sId, status: "discussing", reason: "r" },
			ts: new Date().toISOString(),
			hash: hashEvent("override-status", { sliceId: sId, status: "discussing", reason: "r" }),
			actor: "agent",
			session_id: "s",
		};
		appendFileSync(logPath, `${JSON.stringify(e1)}\n`);
		appendFileSync(logPath, "{this is not valid json\n");
		const e3 = {
			v: 2,
			cmd: "override-status",
			params: { sliceId: sId, status: "researching", reason: "r2" },
			ts: new Date().toISOString(),
			hash: hashEvent("override-status", { sliceId: sId, status: "researching", reason: "r2" }),
			actor: "agent",
			session_id: "s",
		};
		appendFileSync(logPath, `${JSON.stringify(e3)}\n`);

		tailReplay(db, root);

		// readEvents filters malformed line; only 2 valid events
		expect(loadCursor(db).lastRow).toBe(2);
		expect(getSlice(db, sId)?.status).toBe("researching");
	});
});
