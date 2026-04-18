import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { applyMigrations } from "../../../src/common/db.js";
import {
	appendCommand,
	hashEvent,
	loadCursor,
	readEvents,
	updateLogCursor,
} from "../../../src/common/event-log.js";

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tff-event-log-"));
	mkdirSync(join(root, ".tff"), { recursive: true });
	return root;
}

describe("hashEvent", () => {
	test("is deterministic for same cmd+params", () => {
		const a = hashEvent("transition", { sliceId: "s1", to: "verifying" });
		const b = hashEvent("transition", { sliceId: "s1", to: "verifying" });
		expect(a).toBe(b);
		expect(a.length).toBe(16);
	});

	test("differs when params differ", () => {
		const a = hashEvent("transition", { sliceId: "s1" });
		const b = hashEvent("transition", { sliceId: "s2" });
		expect(a).not.toBe(b);
	});
});

describe("readEvents", () => {
	test("returns empty array when log file absent", () => {
		const root = tempRoot();
		expect(readEvents(root)).toEqual([]);
	});

	test("returns parsed events in order", () => {
		const root = tempRoot();
		const lines = [
			JSON.stringify({
				v: 2,
				cmd: "write-spec",
				params: { sliceId: "s1" },
				ts: "2026-04-17T00:00:00Z",
				hash: "aaaa",
				actor: "agent",
				session_id: "sess1",
			}),
			JSON.stringify({
				v: 2,
				cmd: "write-plan",
				params: { sliceId: "s1" },
				ts: "2026-04-17T00:00:01Z",
				hash: "bbbb",
				actor: "agent",
				session_id: "sess1",
			}),
		];
		writeFileSync(join(root, ".tff/event-log.jsonl"), `${lines.join("\n")}\n`);
		const events = readEvents(root);
		expect(events).toHaveLength(2);
		expect(events[0]?.cmd).toBe("write-spec");
		expect(events[1]?.cmd).toBe("write-plan");
	});

	test("fromRow skips first N rows", () => {
		const root = tempRoot();
		const lines = [1, 2, 3].map((i) =>
			JSON.stringify({
				v: 2,
				cmd: `cmd${i}`,
				params: {},
				ts: "t",
				hash: `h${i}`,
				actor: "agent",
				session_id: "s",
			}),
		);
		writeFileSync(join(root, ".tff/event-log.jsonl"), `${lines.join("\n")}\n`);
		const events = readEvents(root, 1);
		expect(events).toHaveLength(2);
		expect(events[0]?.cmd).toBe("cmd2");
	});

	test("readEvents skips malformed JSON lines and continues", () => {
		const root = tempRoot();
		const good = JSON.stringify({
			v: 2,
			cmd: "write-spec",
			params: {},
			ts: "t",
			hash: "h",
			actor: "agent",
			session_id: "s",
		});
		const lines = [good, "not json", good];
		writeFileSync(join(root, ".tff/event-log.jsonl"), `${lines.join("\n")}\n`);
		const events = readEvents(root);
		expect(events).toHaveLength(2);
		expect(events[0]?.cmd).toBe("write-spec");
		expect(events[1]?.cmd).toBe("write-spec");
	});
});

describe("appendCommand", () => {
	test("appends a fsync'd JSONL line with correct envelope", () => {
		const root = tempRoot();
		const result = appendCommand(root, "write-spec", { sliceId: "s1" });
		expect(result.hash).toHaveLength(16);
		expect(result.row).toBe(1);

		const file = readFileSync(join(root, ".tff/event-log.jsonl"), "utf-8");
		const parsed = JSON.parse(file.trim());
		expect(parsed.v).toBe(2);
		expect(parsed.cmd).toBe("write-spec");
		expect(parsed.params).toEqual({ sliceId: "s1" });
		expect(parsed.actor).toBe("agent");
		expect(parsed.hash).toBe(result.hash);
		expect(typeof parsed.ts).toBe("string");
		expect(typeof parsed.session_id).toBe("string");
	});

	test("assigns sequential row numbers across calls", () => {
		const root = tempRoot();
		const r1 = appendCommand(root, "write-spec", { sliceId: "s1" });
		const r2 = appendCommand(root, "write-plan", { sliceId: "s1" });
		const r3 = appendCommand(root, "execute-done", { sliceId: "s1" });
		expect([r1.row, r2.row, r3.row]).toEqual([1, 2, 3]);
	});

	test("respects meta.actor override", () => {
		const root = tempRoot();
		appendCommand(root, "state-rename", { from: "x", to: "y" }, { actor: "user" });
		const raw = readFileSync(join(root, ".tff/event-log.jsonl"), "utf-8");
		expect(JSON.parse(raw.trim()).actor).toBe("user");
	});

	test("row is physical newline count, not filtered-event count", () => {
		const root = tempRoot();
		const r1 = appendCommand(root, "write-spec", { sliceId: "s1" });
		expect(r1.row).toBe(1);

		// Inject a malformed line directly (bypassing appendCommand)
		const logPath = join(root, ".tff/event-log.jsonl");
		appendFileSync(logPath, "not valid json\n");

		// After malformed line, physical count becomes 3 for the next append
		const r2 = appendCommand(root, "write-plan", { sliceId: "s1" });
		expect(r2.row).toBe(3);
	});
});

describe("readEvents — physical line offset", () => {
	test("fromPhysicalLine skips exactly N physical lines including malformed", () => {
		const root = tempRoot();
		const logPath = join(root, ".tff/event-log.jsonl");

		const eventA = JSON.stringify({
			v: 2,
			cmd: "write-spec",
			params: {},
			ts: "t",
			hash: "hA",
			actor: "agent" as const,
			session_id: "s",
		});
		const eventB = JSON.stringify({
			v: 2,
			cmd: "write-plan",
			params: {},
			ts: "t",
			hash: "hB",
			actor: "agent" as const,
			session_id: "s",
		});
		appendFileSync(logPath, `${eventA}\n`);
		appendFileSync(logPath, "not valid json\n");
		appendFileSync(logPath, `${eventB}\n`);

		// 3 physical lines total; readEvents(root, 3) must return nothing
		expect(readEvents(root, 3)).toHaveLength(0);
	});

	test("fromPhysicalLine=2 starts at the third physical line", () => {
		const root = tempRoot();
		const logPath = join(root, ".tff/event-log.jsonl");

		const eventA = JSON.stringify({
			v: 2,
			cmd: "write-spec",
			params: {},
			ts: "t",
			hash: "hA",
			actor: "agent" as const,
			session_id: "s",
		});
		const eventB = JSON.stringify({
			v: 2,
			cmd: "write-plan",
			params: {},
			ts: "t",
			hash: "hB",
			actor: "agent" as const,
			session_id: "s",
		});
		appendFileSync(logPath, `${eventA}\n`);
		appendFileSync(logPath, "not valid json\n");
		appendFileSync(logPath, `${eventB}\n`);

		const events = readEvents(root, 2);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-plan");
	});
});

describe("cursor operations", () => {
	test("loadCursor returns default on fresh db", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		db.prepare("INSERT INTO project (id, name, vision) VALUES ('p1', 'n', 'v')").run();
		const cursor = loadCursor(db);
		expect(cursor).toEqual({ lastHash: null, lastRow: 0 });
	});

	test("updateLogCursor persists and loadCursor reads it", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		db.prepare("INSERT INTO project (id, name, vision) VALUES ('p1', 'n', 'v')").run();
		updateLogCursor(db, "abc1234567890def", 5);
		expect(loadCursor(db)).toEqual({ lastHash: "abc1234567890def", lastRow: 5 });
	});
});
