import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteArtifact, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getSlice,
	insertEventLog,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { auditVerification } from "../../../src/common/evidence-auditor.js";
import type { Slice } from "../../../src/common/types.js";
import { handleWriteVerification } from "../../../src/tools/write-verification.js";

// These tests exercise the two load-bearing halves (handleWriteVerification
// and auditVerification) against the same real DB + real filesystem. Together
// they prove the contract that write-verification.execute() enforces after
// Task 4 wires the auditor in.

describe("write-verification audit integration", () => {
	let tmp: string;
	let db: Database.Database;
	let slice: Slice;

	function seedBashEvent(command: string, isError: boolean): void {
		const payload = JSON.stringify({
			timestamp: "2026-04-13T12:00:00Z",
			type: "tool_call",
			sliceId: slice.id,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			phase: "verify",
			toolCallId: `c-${Math.random().toString(36).slice(2, 8)}`,
			toolName: "bash",
			input: { command },
			output: isError ? "fail" : "ok",
			isError,
			durationMs: 10,
			startedAt: "2026-04-13T12:00:00Z",
		});
		insertEventLog(db, { channel: "tff:tool", type: "tool_call", sliceId: slice.id, payload });
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tff-wva-"));
		mkdirSync(join(tmp, ".tff"), { recursive: true });
		db = new Database(":memory:");
		applyMigrations(db);

		const projectId = insertProject(db, { name: "test", vision: "test vision" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});
		const sliceId = insertSlice(db, { milestoneId, number: 1, title: "slice 1" });
		const s = getSlice(db, sliceId);
		if (!s) throw new Error("test setup: failed to read back inserted rows");
		slice = s;
	});

	afterEach(() => {
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("all-matching claims → audit report has zero mismatches, hasMismatches=false", () => {
		seedBashEvent("bun run test", false);
		const md = "Ran `bun run test` — all pass";
		handleWriteVerification(db, tmp, slice.id, md);
		const report = auditVerification(db, slice.id, md);
		expect(report.hasMismatches).toBe(false);
		expect(report.summary.mismatch).toBe(0);
		expect(report.summary.match).toBe(1);
	});

	it("mismatching claim → hasMismatches=true so the tool will return isError and NOT emit phase_complete", () => {
		seedBashEvent("bun run test", true);
		const md = "Ran `bun run test` — all pass";
		handleWriteVerification(db, tmp, slice.id, md);
		const report = auditVerification(db, slice.id, md);
		expect(report.hasMismatches).toBe(true);
		expect(report.summary.mismatch).toBe(1);
	});

	it("only-unverifiable claims → hasMismatches=false (non-blocking warning)", () => {
		const md = "Ran `mystery_cmd` — all pass";
		handleWriteVerification(db, tmp, slice.id, md);
		const report = auditVerification(db, slice.id, md);
		expect(report.hasMismatches).toBe(false);
		expect(report.summary.unverifiable).toBe(1);
	});

	it("no claims parsed → findings=[], hasMismatches=false", () => {
		const md = "A verification report with no commands mentioned.";
		handleWriteVerification(db, tmp, slice.id, md);
		const report = auditVerification(db, slice.id, md);
		expect(report.findings).toHaveLength(0);
		expect(report.hasMismatches).toBe(false);
	});

	it("deleteArtifact removes stale VERIFICATION-AUDIT.md on passing retry", () => {
		const auditPath = "milestones/M01/slices/M01-S01/VERIFICATION-AUDIT.md";
		writeArtifact(tmp, auditPath, "# stale");
		expect(existsSync(join(tmp, ".tff", auditPath))).toBe(true);
		deleteArtifact(tmp, auditPath);
		expect(existsSync(join(tmp, ".tff", auditPath))).toBe(false);
	});
});
