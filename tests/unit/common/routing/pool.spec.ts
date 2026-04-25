import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POOL_IDS, loadPool } from "../../../../src/common/routing/pool.js";

describe("DEFAULT_POOL_IDS", () => {
	it("review default is single tff-code-reviewer", () => {
		expect(DEFAULT_POOL_IDS.review).toEqual(["tff-code-reviewer"]);
	});
	it("execute default is tff-executor", () => {
		expect(DEFAULT_POOL_IDS.execute).toEqual(["tff-executor"]);
	});
	it("verify default is tff-verifier", () => {
		expect(DEFAULT_POOL_IDS.verify).toEqual(["tff-verifier"]);
	});
});

describe("loadPool", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-pool-"));
		mkdirSync(join(root, "src/resources/agents"), { recursive: true });
		copyFileSync(
			"tests/fixtures/routing/agents/tff-test-handler.md",
			join(root, "src/resources/agents/tff-test-handler.md"),
		);
		copyFileSync(
			"src/resources/agents/tff-code-reviewer.md",
			join(root, "src/resources/agents/tff-code-reviewer.md"),
		);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("AC-07: settings override for phase", async () => {
		const pool = await loadPool(root, "review", { pools: { review: ["tff-test-handler"] } });
		expect(pool.phase).toBe("review");
		expect(pool.agents.map((a) => a.id)).toEqual(["tff-test-handler"]);
	});
	it("AC-07: DEFAULT_POOL_IDS used when override absent", async () => {
		const pool = await loadPool(root, "review", { pools: {} });
		expect(pool.agents.map((a) => a.id)).toEqual(["tff-code-reviewer"]);
	});
	it("propagates AgentLoadError when configured agent missing", async () => {
		await expect(
			loadPool(root, "review", { pools: { review: ["tff-spec-reviewer"] } }),
		).rejects.toMatchObject({ name: "AgentLoadError", code: "AGENT_NOT_FOUND" });
	});
});
