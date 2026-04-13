import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, insertEventLog } from "../../../src/common/db.js";
import {
	auditVerification,
	formatAuditReport,
	parseVerificationClaims,
} from "../../../src/common/evidence-auditor.js";

describe("parseVerificationClaims", () => {
	it("returns [] for empty input", () => {
		expect(parseVerificationClaims("")).toEqual([]);
	});

	it("parses backticked command with 'all pass' keyword (expectedExit=0)", () => {
		const md = "Ran `bun run test` — all 677 tests pass.";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run test", expectedExit: 0 });
	});

	it("parses backticked command with explicit 'exit 1'", () => {
		const md = "`bun run test` exit 1";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run test", expectedExit: 1 });
	});

	it("parses fenced-block '$ <cmd>' with clean output as expectedExit=0", () => {
		const md = "```\n$ bun run typecheck\n```\n";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run typecheck", expectedExit: 0 });
	});

	it("parses fenced-block '$ <cmd>' with 'error:' in output as expectedExit=1", () => {
		const md = "```\n$ foo\nerror: bar\n```\n";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "foo", expectedExit: 1 });
	});

	it("parses AC checkbox [x] with backticked command as expectedExit=0", () => {
		const md = "- [x] AC-3: verified via `rg setCurrentPhase src/`";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "rg setCurrentPhase src/", expectedExit: 0 });
	});

	it("parses AC checkbox [ ] with backticked command as expectedExit=1", () => {
		const md = "- [ ] AC-4: could not verify via `rg foo`";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "rg foo", expectedExit: 1 });
	});

	it("ignores very short backticked tokens (< 3 chars) and empty backticks", () => {
		const md = "Ran `` which pass. Then `x` failed.";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(0);
	});

	it("fenced block: blank lines in output don't terminate the failure scan", () => {
		// Real bun/jest output often has blank lines between sections,
		// with the failure summary only visible AFTER the blank line.
		const md = "```\n$ bun test\n\nerror: assertion failed\n```\n";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun test", expectedExit: 1 });
	});
});

describe("auditVerification", () => {
	let db: Database.Database;
	const SLICE_ID = "slice-test-1";

	function seedBashEvent(command: string, isError: boolean, startedAt: string): void {
		const payload = JSON.stringify({
			timestamp: startedAt,
			type: "tool_call",
			sliceId: SLICE_ID,
			sliceLabel: "M09-S02",
			milestoneNumber: 9,
			phase: "verify",
			toolCallId: `c-${Math.random().toString(36).slice(2, 10)}`,
			toolName: "bash",
			input: { command },
			output: isError ? "exit 1" : "ok",
			isError,
			durationMs: 42,
			startedAt,
		});
		insertEventLog(db, {
			channel: "tff:tool",
			type: "tool_call",
			sliceId: SLICE_ID,
			payload,
		});
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
	});
	afterEach(() => {
		db.close();
	});

	it("verdict=match when claim says pass and event has isError=false", () => {
		seedBashEvent("bun run test", false, "2026-04-13T12:00:01Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(db, SLICE_ID, md);
		expect(report.summary).toEqual({ match: 1, mismatch: 0, unverifiable: 0 });
		expect(report.hasMismatches).toBe(false);
		expect(report.findings[0]?.verdict).toBe("match");
	});

	it("verdict=mismatch when claim says pass and event has isError=true", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(db, SLICE_ID, md);
		expect(report.summary).toEqual({ match: 0, mismatch: 1, unverifiable: 0 });
		expect(report.hasMismatches).toBe(true);
		expect(report.findings[0]?.verdict).toBe("mismatch");
		expect(report.findings[0]?.evidence?.actualExit).toBe(1);
	});

	it("verdict=unverifiable when no tool-call record matches the claim", () => {
		const md = "Ran `obscure_cmd_nobody_knows` — all pass";
		const report = auditVerification(db, SLICE_ID, md);
		expect(report.summary).toEqual({ match: 0, mismatch: 0, unverifiable: 1 });
		expect(report.hasMismatches).toBe(false);
		expect(report.findings[0]?.verdict).toBe("unverifiable");
	});

	it("matcher picks the most recent event by startedAt when multiple candidates exist", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		seedBashEvent("bun run test", false, "2026-04-13T12:05:00Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(db, SLICE_ID, md);
		expect(report.findings[0]?.verdict).toBe("match");
		expect(report.findings[0]?.evidence?.actualExit).toBe(0);
	});

	it("formatAuditReport produces markdown with all three sections when findings exist", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		seedBashEvent("bun run typecheck", false, "2026-04-13T12:00:02Z");
		const md =
			"Ran `bun run test` — all pass\nRan `bun run typecheck` — all pass\nRan `rg nope src/` — all pass";
		const report = auditVerification(db, SLICE_ID, md);
		const formatted = formatAuditReport(report);
		expect(formatted).toContain("# Verification Audit");
		expect(formatted).toContain("## Mismatches");
		expect(formatted).toContain("## Unverifiable");
		expect(formatted).toContain("## Matches");
	});
});
