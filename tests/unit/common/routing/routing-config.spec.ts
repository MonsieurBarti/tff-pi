import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRoutingConfig } from "../../../../src/common/routing/routing-config.js";

const FIX = "tests/fixtures/routing/settings";

describe("loadRoutingConfig", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-routing-config-"));
		mkdirSync(join(root, ".pi/.tff"), { recursive: true });
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const seed = (name: string) =>
		copyFileSync(`${FIX}/${name}.yaml`, join(root, ".pi/.tff/settings.yaml"));

	it("AC-05: missing settings.yaml → defaults", async () => {
		const cfg = await loadRoutingConfig(root);
		expect(cfg).toEqual({
			enabled: false,
			confidence_threshold: 0,
			tier_policy: undefined,
			pools: {},
		});
	});

	it("AC-05: unknown calibration keys pass through silently", async () => {
		seed("with-unknown-keys");
		const cfg = await loadRoutingConfig(root);
		expect(cfg.enabled).toBe(true);
	});

	it("AC-06: partial tier_policy → SCHEMA_VIOLATION", async () => {
		seed("bad-partial-policy");
		await expect(loadRoutingConfig(root)).rejects.toMatchObject({
			name: "RoutingConfigParseError",
			code: "SCHEMA_VIOLATION",
		});
	});

	it("AC-06: mistyped phase → SCHEMA_VIOLATION", async () => {
		seed("bad-mistyped-phase");
		await expect(loadRoutingConfig(root)).rejects.toMatchObject({
			code: "SCHEMA_VIOLATION",
		});
	});

	it("AC-06: confidence_threshold > 1 → SCHEMA_VIOLATION", async () => {
		seed("bad-confidence-threshold");
		await expect(loadRoutingConfig(root)).rejects.toMatchObject({
			code: "SCHEMA_VIOLATION",
		});
	});

	it("full opt-in parses correctly", async () => {
		seed("full");
		const cfg = await loadRoutingConfig(root);
		expect(cfg.enabled).toBe(true);
		expect(cfg.confidence_threshold).toBe(0.5);
		expect(cfg.tier_policy).toEqual({
			low: "haiku",
			medium: "sonnet",
			high: "opus",
		});
		expect(cfg.pools.review).toEqual(["tff-spec-reviewer", "tff-code-reviewer"]);
	});

	it("partial yaml fills defaults", async () => {
		seed("partial");
		const cfg = await loadRoutingConfig(root);
		expect(cfg).toEqual({
			enabled: true,
			confidence_threshold: 0,
			tier_policy: undefined,
			pools: {},
		});
	});
});
