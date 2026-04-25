import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentLoadError,
	readAgentCapability,
} from "../../../../src/common/routing/agent-loader.js";

const FIX = "tests/fixtures/routing/agents";

describe("readAgentCapability", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-agent-loader-"));
		mkdirSync(join(root, ".pi/agents"), { recursive: true });
		mkdirSync(join(root, "src/resources/agents"), { recursive: true });
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reads from .pi/agents first", async () => {
		copyFileSync(`${FIX}/tff-test-handler.md`, join(root, ".pi/agents/tff-test-handler.md"));
		const cap = await readAgentCapability(root, "tff-test-handler");
		expect(cap.id).toBe("tff-test-handler");
		expect(cap.handles).toEqual(["high_risk", "auth"]);
		expect(cap.priority).toBe(7);
	});

	it("falls back to src/resources/agents", async () => {
		copyFileSync(
			`${FIX}/tff-test-min-tier.md`,
			join(root, "src/resources/agents/tff-test-min-tier.md"),
		);
		const cap = await readAgentCapability(root, "tff-test-min-tier");
		expect(cap.id).toBe("tff-test-min-tier");
		expect(cap.min_tier).toBe("sonnet");
	});

	it("AC-08c: throws AGENT_NOT_FOUND when both paths missing", async () => {
		await expect(readAgentCapability(root, "missing")).rejects.toMatchObject({
			name: "AgentLoadError",
			code: "AGENT_NOT_FOUND",
			agent_id: "missing",
		});
		expect(AgentLoadError).toBeDefined();
	});

	it("throws INVALID_FRONTMATTER on malformed file", async () => {
		writeFileSync(join(root, ".pi/agents/bad.md"), "---\nnot: valid: routing\n---\n# bad\n");
		await expect(readAgentCapability(root, "bad")).rejects.toMatchObject({
			name: "AgentLoadError",
			code: "INVALID_FRONTMATTER",
			agent_id: "bad",
		});
	});
});
