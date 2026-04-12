import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import type { Slice } from "../../../src/common/types.js";
import { preflightCheck } from "../../../src/phases/ship.js";

describe("preflightCheck", () => {
	let root: string;

	const fakeSlice: Slice = {
		id: "slice-1",
		milestoneId: "ms-1",
		number: 1,
		title: "Auth",
		status: "reviewing",
		tier: "SS",
		prUrl: null,
		createdAt: "2025-01-01T00:00:00Z",
	};

	const base = "milestones/M01/slices/M01-S01";

	function writeAllArtifacts(root: string, verification = "# Verification\n- [x] All checks pass") {
		writeArtifact(root, `${base}/SPEC.md`, "# Spec\nAC-1: works");
		writeArtifact(root, `${base}/PLAN.md`, "# Plan\nStep 1: do it");
		writeArtifact(root, `${base}/REQUIREMENTS.md`, "# Requirements\nR1: must work");
		writeArtifact(root, `${base}/VERIFICATION.md`, verification);
		writeArtifact(root, `${base}/REVIEW.md`, "# Review\nApproved");
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-preflight-"));
		initTffDirectory(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("passes when all 5 artifacts exist and verification is clean", () => {
		writeAllArtifacts(root);
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("fails when SPEC.md is missing", () => {
		writeAllArtifacts(root);
		// Overwrite SPEC.md with empty content to simulate missing
		writeArtifact(root, `${base}/SPEC.md`, "");
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("SPEC.md missing")]),
		);
	});

	it("fails when VERIFICATION.md has unchecked items", () => {
		writeAllArtifacts(root, "# Verification\n- [ ] Pending check\n- [x] Done check");
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("unchecked")]));
	});

	it("fails when VERIFICATION.md contains FAIL marker", () => {
		writeAllArtifacts(root, "# Verification\n- [x] Check 1\nResult: FAIL");
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("failure marker")]),
		);
	});

	it("fails when VERIFICATION.md contains BLOCKED marker", () => {
		writeAllArtifacts(root, "# Verification\n- [x] Check 1\nStatus: BLOCKED");
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("failure marker")]),
		);
	});

	it("reports multiple errors at once", () => {
		// Only write VERIFICATION.md with unchecked items — other artifacts missing
		writeArtifact(root, `${base}/VERIFICATION.md`, "# Verification\n- [ ] Not done\nFAIL");
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(false);
		// Should have errors for SPEC.md, PLAN.md, REQUIREMENTS.md, REVIEW.md missing
		// plus unchecked items and failure marker
		expect(result.errors.length).toBeGreaterThanOrEqual(5);
	});

	it("passes when VERIFICATION.md mentions lowercase 'fail' in prose (e.g. '0 fail')", () => {
		// Regression: the preflight used to be case-insensitive and false-flagged
		// test-summary lines like "0 fail" or "would fail if..." as verdicts.
		// FAIL/BLOCKED are shouty-case verdict markers only.
		writeAllArtifacts(
			root,
			"# Verification\n- [x] Check 1\n```\n59 pass\n0 fail\n```\nOverall: PASS",
		);
		const result = preflightCheck(root, fakeSlice, 1);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("S-tier preflight still requires REVIEW.md (review required for all tiers)", () => {
		const sTierSlice: Slice = { ...fakeSlice, tier: "S" };
		writeArtifact(root, `${base}/SPEC.md`, "# Spec");
		writeArtifact(root, `${base}/PLAN.md`, "# Plan");
		writeArtifact(root, `${base}/REQUIREMENTS.md`, "# Requirements");
		writeArtifact(root, `${base}/VERIFICATION.md`, "# Verification\n- [x] ok");
		const result = preflightCheck(root, sTierSlice, 1);
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("REVIEW.md missing")]),
		);
	});
});
