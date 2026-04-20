import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	auditVerification,
	auditVerificationAgainstCapture,
	formatAuditReport,
	parseVerificationClaims,
} from "../../../src/common/evidence-auditor.js";
import { PerSliceLog } from "../../../src/common/per-slice-log.js";
import type { CapturedCall } from "../../../src/common/subagent-dispatcher.js";

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

	it("short claim 'bun' does not match 'bun run test' (exploit hardening)", () => {
		// Before: substring-matcher allowed claim 'bun' to silently match any captured bun call.
		// After: token-based matcher requires full claim-token prefix of actual tokens OR exact string match for single-token claims.
		// This test pins the parser step only — matcher coverage is in the auditVerification describe.
		const md = "Ran `bun` — all pass";
		const claims = parseVerificationClaims(md);
		// Parsing is permissive (still returns a claim); matcher rejects by token-prefix.
		// See auditVerification test below for the full integration.
		expect(claims).toHaveLength(1);
		expect(claims[0]?.command).toBe("bun");
	});

	it("cross-pattern dedup: same command in fenced block AND inline verdict only counted once per (command, expectedExit)", () => {
		const md = "Ran `bun run test` — all pass\n\n```\n$ bun run test\nok\n```";
		const claims = parseVerificationClaims(md);
		// Both patterns produce (command: "bun run test", expectedExit: 0).
		// Dedup key collapses them.
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run test", expectedExit: 0 });
	});

	it("conflicting-verdict dedup: fenced fail + inline pass for same command surface BOTH findings", () => {
		const md = "Ran `bun run test` — all pass\n\n```\n$ bun run test\nerror: broken\n```";
		const claims = parseVerificationClaims(md);
		// Different expectedExit (0 vs 1) → different dedup key → both kept.
		// A future reviewer can see the agent contradicted itself.
		expect(claims).toHaveLength(2);
	});

	it("prose-only verification with no parseable claims returns [] (known limitation)", () => {
		const md = "I ran the tests and they all pass. The code works.";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(0);
	});
});

describe("auditVerification", () => {
	let root: string;
	let log: PerSliceLog;
	let bus: ReturnType<typeof makeBus>;
	const SLICE_LABEL = "M09-S02";

	function seedBashEvent(command: string, isError: boolean, startedAt: string): void {
		bus.emit("tff:tool", {
			timestamp: startedAt,
			type: "tool_call",
			sliceId: "slice-test-1",
			sliceLabel: SLICE_LABEL,
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
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-audit-"));
		bus = makeBus();
		log = new PerSliceLog(root);
		log.subscribe(bus);
	});

	afterEach(() => {
		log.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	it("verdict=match when claim says pass and event has isError=false", () => {
		seedBashEvent("bun run test", false, "2026-04-13T12:00:01Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		expect(report.summary).toEqual({ match: 1, mismatch: 0, unverifiable: 0 });
		expect(report.hasMismatches).toBe(false);
		expect(report.findings[0]?.verdict).toBe("match");
	});

	it("verdict=mismatch when claim says pass and event has isError=true", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		expect(report.summary).toEqual({ match: 0, mismatch: 1, unverifiable: 0 });
		expect(report.hasMismatches).toBe(true);
		expect(report.findings[0]?.verdict).toBe("mismatch");
		expect(report.findings[0]?.evidence?.actualExit).toBe(1);
	});

	it("verdict=unverifiable when no tool-call record matches the claim", () => {
		const md = "Ran `obscure_cmd_nobody_knows` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		expect(report.summary).toEqual({ match: 0, mismatch: 0, unverifiable: 1 });
		expect(report.hasMismatches).toBe(false);
		expect(report.findings[0]?.verdict).toBe("unverifiable");
	});

	it("matcher picks the most recent event by startedAt when multiple candidates exist", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		seedBashEvent("bun run test", false, "2026-04-13T12:05:00Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		expect(report.findings[0]?.verdict).toBe("match");
		expect(report.findings[0]?.evidence?.actualExit).toBe(0);
	});

	it("matcher: single-token claim 'bun' does NOT match captured 'bun run test'", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		const md = "Ran `bun` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		// Short-claim matcher returns unverifiable (no token-prefix match with "bun run test").
		expect(report.findings[0]?.verdict).toBe("unverifiable");
		expect(report.summary.unverifiable).toBe(1);
	});

	it("matcher: token-prefix claim 'bun run test' DOES match captured 'bun run test --watch' (paraphrase allowed)", () => {
		seedBashEvent("bun run test --watch", false, "2026-04-13T12:00:01Z");
		const md = "Ran `bun run test` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		expect(report.findings[0]?.verdict).toBe("match");
	});

	it("formatAuditReport produces markdown with all three sections when findings exist", () => {
		seedBashEvent("bun run test", true, "2026-04-13T12:00:01Z");
		seedBashEvent("bun run typecheck", false, "2026-04-13T12:00:02Z");
		const md =
			"Ran `bun run test` — all pass\nRan `bun run typecheck` — all pass\nRan `rg nope src/` — all pass";
		const report = auditVerification(root, SLICE_LABEL, md);
		const formatted = formatAuditReport(report);
		expect(formatted).toContain("# Verification Audit");
		expect(formatted).toContain("## Mismatches");
		expect(formatted).toContain("## Unverifiable");
		expect(formatted).toContain("## Matches");
	});
});

describe("auditVerificationAgainstCapture", () => {
	it("returns hasMismatches=false when all claimed commands succeeded", () => {
		const vMd = "Ran `bun test` — all pass.";
		const calls: CapturedCall[] = [
			{
				toolName: "bash",
				toolCallId: "c1",
				input: { command: "bun test" },
				isError: false,
				outputText: "7 pass, 0 fail",
				timestamp: 1,
			},
		];
		const report = auditVerificationAgainstCapture(vMd, calls);
		expect(report.hasMismatches).toBe(false);
	});

	it("flags a pass-claim against an isError call", () => {
		const vMd = "Ran `bun test` — all pass.";
		const calls: CapturedCall[] = [
			{
				toolName: "bash",
				toolCallId: "c1",
				input: { command: "bun test" },
				isError: true,
				outputText: "FAIL",
				timestamp: 1,
			},
		];
		const report = auditVerificationAgainstCapture(vMd, calls);
		expect(report.hasMismatches).toBe(true);
		expect(report.summary.mismatch).toBeGreaterThan(0);
	});

	it("returns AuditReport shape compatible with formatAuditReport", () => {
		const report = auditVerificationAgainstCapture("claim", []);
		expect(() => formatAuditReport(report)).not.toThrow();
	});
});
