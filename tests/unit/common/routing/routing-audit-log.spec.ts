import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type RouteRow,
	type TierRow,
	appendAuditRows,
	readAuditRows,
} from "../../../../src/common/routing/routing-audit-log.js";

const sigs = {
	complexity: "low" as const,
	risk: { level: "low" as const, tags: [] },
};
const baseRow: RouteRow = {
	kind: "route",
	timestamp: "2026-04-25T00:00:00.000Z",
	phase: "review",
	slice_id: "X",
	agent_id: "tff-code-reviewer",
	signals: sigs,
	confidence: 1,
	fallback_used: false,
	decision_id: "r1",
	dry_run: true,
};
const tierRow: TierRow = {
	kind: "tier",
	timestamp: "2026-04-25T00:00:00.000Z",
	phase: "review",
	slice_id: "X",
	agent_id: "tff-code-reviewer",
	signals: sigs,
	tier: null,
	policy_tier: null,
	min_tier_applied: false,
	decision_id: "t1",
	dry_run: true,
};

describe("audit log", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-audit-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("AC-09: round-trips N rows", async () => {
		await appendAuditRows(root, [baseRow, tierRow]);
		expect(await readAuditRows(root)).toEqual([baseRow, tierRow]);
	});
	it("creates parent dirs lazily", async () => {
		await appendAuditRows(root, [baseRow]);
		expect((await readAuditRows(root)).length).toBe(1);
	});
	it("appends across calls (file grows)", async () => {
		await appendAuditRows(root, [baseRow]);
		await appendAuditRows(root, [tierRow]);
		expect((await readAuditRows(root)).length).toBe(2);
	});
	it("readAuditRows returns [] when file missing", async () => {
		expect(await readAuditRows(root)).toEqual([]);
	});
	it("AC-09: malformed line throws with prefix in message", async () => {
		mkdirSync(join(root, ".pi/.tff"), { recursive: true });
		writeFileSync(join(root, ".pi/.tff/routing.jsonl"), '{"kind":"route","bogus":true}\n');
		await expect(readAuditRows(root)).rejects.toThrow(/routing\.jsonl: malformed row/);
	});
	it("appendAuditRows([]) is a no-op (no file written)", async () => {
		await appendAuditRows(root, []);
		expect(await readAuditRows(root)).toEqual([]);
	});
});
