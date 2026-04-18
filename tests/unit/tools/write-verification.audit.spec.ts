import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteArtifact, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { auditVerification } from "../../../src/common/evidence-auditor.js";
import { PerSliceLog } from "../../../src/common/per-slice-log.js";
import { handleWriteVerification } from "../../../src/tools/write-verification.js";

// These tests exercise the two load-bearing halves (handleWriteVerification
// and auditVerification) against the same real FS. Together they prove the
// contract that write-verification.execute() enforces after Task 4 wires the
// auditor in.

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

describe("write-verification audit integration", () => {
	let tmp: string;
	let db: Database.Database;
	let sliceId: string;
	let log: PerSliceLog;
	let bus: ReturnType<typeof makeBus>;
	const SLICE_LABEL = "M01-S01";

	function seedBashEvent(command: string, isError: boolean): void {
		bus.emit("tff:tool", {
			timestamp: "2026-04-13T12:00:00Z",
			type: "tool_call",
			sliceId,
			sliceLabel: SLICE_LABEL,
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
		sliceId = insertSlice(db, { milestoneId, number: 1, title: "slice 1" });
		db.prepare("UPDATE slice SET status = 'verifying' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "verify",
			status: "started",
			startedAt: new Date().toISOString(),
		});

		bus = makeBus();
		log = new PerSliceLog(tmp);
		log.subscribe(bus);
	});

	afterEach(() => {
		log.dispose();
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("all-matching claims → audit report has zero mismatches, hasMismatches=false", () => {
		seedBashEvent("bun run test", false);
		const md = "Ran `bun run test` — all pass";
		handleWriteVerification(db, tmp, sliceId, md);
		const report = auditVerification(tmp, SLICE_LABEL, md);
		expect(report.hasMismatches).toBe(false);
		expect(report.summary.mismatch).toBe(0);
		expect(report.summary.match).toBe(1);
	});

	it("mismatching claim → hasMismatches=true so the tool will return isError and NOT emit phase_complete", () => {
		seedBashEvent("bun run test", true);
		const md = "Ran `bun run test` — all pass";
		handleWriteVerification(db, tmp, sliceId, md);
		const report = auditVerification(tmp, SLICE_LABEL, md);
		expect(report.hasMismatches).toBe(true);
		expect(report.summary.mismatch).toBe(1);
	});

	it("only-unverifiable claims → hasMismatches=false (non-blocking warning)", () => {
		const md = "Ran `mystery_cmd` — all pass";
		handleWriteVerification(db, tmp, sliceId, md);
		const report = auditVerification(tmp, SLICE_LABEL, md);
		expect(report.hasMismatches).toBe(false);
		expect(report.summary.unverifiable).toBe(1);
	});

	it("no claims parsed → findings=[], hasMismatches=false", () => {
		const md = "A verification report with no commands mentioned.";
		handleWriteVerification(db, tmp, sliceId, md);
		const report = auditVerification(tmp, SLICE_LABEL, md);
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

	it("mismatch path writes .audit-blocked sentinel in the slice directory", () => {
		seedBashEvent("bun run test", true);
		const md = "Ran `bun run test` — all pass";
		handleWriteVerification(db, tmp, sliceId, md);
		const report = auditVerification(tmp, SLICE_LABEL, md);

		// Mirror what execute() does on mismatch:
		if (report.hasMismatches) {
			writeArtifact(tmp, "milestones/M01/slices/M01-S01/.audit-blocked", "blocked\n");
		}
		expect(existsSync(join(tmp, ".tff", "milestones/M01/slices/M01-S01/.audit-blocked"))).toBe(
			true,
		);
	});

	it("clean retry removes .audit-blocked sentinel", () => {
		// First, write the sentinel as if a prior run had failed.
		writeArtifact(tmp, "milestones/M01/slices/M01-S01/.audit-blocked", "blocked\n");
		expect(existsSync(join(tmp, ".tff", "milestones/M01/slices/M01-S01/.audit-blocked"))).toBe(
			true,
		);

		// Simulate a clean retry by calling deleteArtifact.
		deleteArtifact(tmp, "milestones/M01/slices/M01-S01/.audit-blocked");
		expect(existsSync(join(tmp, ".tff", "milestones/M01/slices/M01-S01/.audit-blocked"))).toBe(
			false,
		);
	});
});
