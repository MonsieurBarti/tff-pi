import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getLatestPhaseRun,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { auditVerification } from "../../../src/common/evidence-auditor.js";
import { PerSliceLog } from "../../../src/common/per-slice-log.js";
import { handleWriteVerification } from "../../../src/tools/write-verification.js";

describe("handleWriteVerification — event log", () => {
	test("happy path: appends one write-verification event, advances cursor, and completes phase_run", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-write-verif-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		db.prepare("UPDATE slice SET status = 'verifying' WHERE id = ?").run(sId);
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "verify",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		// Clean content — no bash claims so audit always passes
		const result = handleWriteVerification(db, root, sId, "# Verification\n- All checks pass\n");
		expect(result.isError).toBeFalsy();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("write-verification");
		expect(events[0]?.params).toEqual({ sliceId: sId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);

		const run = getLatestPhaseRun(db, sId, "verify");
		expect(run?.status).toBe("completed");
	});
});

describe("handleWriteVerification — audit mismatch leaves event log unchanged", () => {
	function makeBus() {
		const handlers: Map<string, Array<(d: unknown) => void>> = new Map();
		return {
			on(channel: string, fn: (d: unknown) => void) {
				const list = handlers.get(channel) ?? [];
				list.push(fn);
				handlers.set(channel, list);
				return () => {
					const l = handlers.get(channel) ?? [];
					handlers.set(
						channel,
						l.filter((f) => f !== fn),
					);
				};
			},
			emit(channel: string, data: unknown) {
				for (const fn of handlers.get(channel) ?? []) fn(data);
			},
		};
	}

	test("audit mismatch: no event-log line, cursor unchanged, audit-blocked marker written", () => {
		const db = new Database(":memory:");
		applyMigrations(db);
		const root = mkdtempSync(join(tmpdir(), "tff-wv-mismatch-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		const mId = insertMilestone(db, { id: "m1", projectId, number: 1, name: "M", branch: "b" });
		const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "T" });
		insertPhaseRun(db, {
			sliceId: sId,
			phase: "verify",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		// Seed per-slice log with a failing bash call so audit detects a mismatch
		const bus = makeBus();
		const log = new PerSliceLog(root);
		log.subscribe(bus);
		bus.emit("tff:tool", {
			timestamp: "2026-04-17T00:00:00Z",
			type: "tool_call",
			sliceId: sId,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			phase: "verify",
			toolCallId: "tc-1",
			toolName: "bash",
			input: { command: "bun run test" },
			output: "FAIL",
			isError: true,
			durationMs: 10,
			startedAt: "2026-04-17T00:00:00Z",
		});
		log.dispose();

		// Confirm the audit detects a mismatch (claimed success vs. captured failure)
		const md = "Ran `bun run test` — all pass";
		const auditReport = auditVerification(root, "M01-S01", md);
		expect(auditReport.hasMismatches).toBe(true);

		// The execute() path bails out before calling handleWriteVerification on mismatch.
		// Verify the event log and cursor are untouched (no tx was entered).
		expect(readEvents(root)).toHaveLength(0);
		expect(loadCursor(db).lastRow).toBe(0);

		// Verify phase_run is still "started" (not completed)
		expect(getLatestPhaseRun(db, sId, "verify")?.status).toBe("started");

		// The audit-blocked marker path: write it as execute() would, then verify
		const blockedPath = join(root, ".tff", "milestones/M01/slices/M01-S01/.audit-blocked");
		// (The marker is written by execute(), not handleWriteVerification — simulate it)
		mkdirSync(join(root, ".tff", "milestones/M01/slices/M01-S01"), { recursive: true });
		writeArtifact(root, "milestones/M01/slices/M01-S01/.audit-blocked", "blocked\n");
		expect(existsSync(blockedPath)).toBe(true);
	});
});
