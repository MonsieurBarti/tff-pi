import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/subagent-details-verify.json";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readPkgVersion(pkgRelPath: string): string {
	const raw = readFileSync(join(repoRoot, "node_modules", pkgRelPath, "package.json"), "utf-8");
	return JSON.parse(raw).version as string;
}

describe("subagent-details-verify fixture", () => {
	it("conforms to SubagentDetails shape", () => {
		expect(fixture.toolName).toBe("subagent");
		expect(fixture.details.mode).toBe("single");
		expect(Array.isArray(fixture.details.results)).toBe(true);
		const first = fixture.details.results[0];
		expect(first).toBeDefined();
		if (!first) throw new Error("no result");
		expect(Array.isArray(first.messages)).toBe(true);
		const assistant = first.messages.find(
			(m: { role: string; content?: unknown }) =>
				m.role === "assistant" && Array.isArray(m.content),
		);
		expect(assistant).toBeDefined();
	});

	it("pi-ai version matches installed @mariozechner/pi-ai", () => {
		expect(fixture._meta.piAiVersion).toBe(readPkgVersion("@mariozechner/pi-ai"));
	});

	it("pi-subagents version matches installed pi-subagents", () => {
		expect(fixture._meta.piSubagentsVersion).toBe(readPkgVersion("pi-subagents"));
	});
});
