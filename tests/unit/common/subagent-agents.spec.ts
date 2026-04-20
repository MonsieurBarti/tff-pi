import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TFF_AGENT_NAMES, ensureProjectAgents } from "../../../src/common/subagent-agents.js";

const RESOURCES_DIR = join(process.cwd(), "src", "resources");
const OUTPUT_CONTRACT_RE =
	/^STATUS: <DONE\|DONE_WITH_CONCERNS\|NEEDS_CONTEXT\|BLOCKED>\s*$\n^EVIDENCE: <one-line summary>\s*$/m;

function parseFrontmatter(content: string): Record<string, string> {
	const m = content.match(/^---\n([\s\S]*?)\n---/);
	if (!m || !m[1]) return {};
	const out: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (!kv || !kv[1] || kv[2] === undefined) continue;
		let v = kv[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		out[kv[1]] = v;
	}
	return out;
}

describe("subagent-agents: source files", () => {
	it.each(TFF_AGENT_NAMES)("%s has required frontmatter fields", (name) => {
		const content = readFileSync(join(RESOURCES_DIR, "agents", `${name}.md`), "utf-8");
		const fm = parseFrontmatter(content);
		expect(fm.name).toBe(name);
		expect(fm.description).toBeTruthy();
		const tools =
			fm.tools
				?.split(",")
				.map((t) => t.trim())
				.filter(Boolean) ?? [];
		expect(tools.length).toBeGreaterThan(0);
		expect(fm.thinking).toBe("off");
		expect(fm.systemPromptMode).toBe("replace");
		expect(["true", "false"]).toContain(fm.inheritProjectContext);
		expect(fm.inheritSkills).toBe("false");
	});

	it.each(["tff-code-reviewer", "tff-security-auditor"] as const)(
		"%s excludes write tools",
		(name) => {
			const fm = parseFrontmatter(
				readFileSync(join(RESOURCES_DIR, "agents", `${name}.md`), "utf-8"),
			);
			const tools = (fm.tools ?? "").split(",").map((t) => t.trim());
			expect(tools).not.toContain("edit");
			expect(tools).not.toContain("write");
		},
	);

	it("tff-verifier includes write (for VERIFICATION.md / PR.md) but excludes edit", () => {
		const fm = parseFrontmatter(
			readFileSync(join(RESOURCES_DIR, "agents", "tff-verifier.md"), "utf-8"),
		);
		const tools = (fm.tools ?? "").split(",").map((t) => t.trim());
		expect(tools).toContain("write");
		expect(tools).not.toContain("edit");
	});

	it.each(["tff-code-reviewer", "tff-security-auditor"] as const)(
		"%s also excludes bash",
		(name) => {
			const fm = parseFrontmatter(
				readFileSync(join(RESOURCES_DIR, "agents", `${name}.md`), "utf-8"),
			);
			const tools = (fm.tools ?? "").split(",").map((t) => t.trim());
			expect(tools).not.toContain("bash");
		},
	);

	it.each(TFF_AGENT_NAMES)("%s body contains output contract", (name) => {
		const content = readFileSync(join(RESOURCES_DIR, "agents", `${name}.md`), "utf-8");
		expect(content).toMatch(OUTPUT_CONTRACT_RE);
	});
});

describe("subagent-agents: ensureProjectAgents", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-agents-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("exports TFF_AGENT_NAMES of length 5", () => {
		expect(TFF_AGENT_NAMES).toHaveLength(5);
	});

	it("creates .pi/agents/ and writes all 5 files byte-identical to source", () => {
		ensureProjectAgents(root, RESOURCES_DIR);
		expect(existsSync(join(root, ".pi", "agents"))).toBe(true);
		for (const name of TFF_AGENT_NAMES) {
			const src = readFileSync(join(RESOURCES_DIR, "agents", `${name}.md`));
			const dst = readFileSync(join(root, ".pi", "agents", `${name}.md`));
			expect(Buffer.compare(src, dst)).toBe(0);
		}
	});

	it("is idempotent — calling twice leaves files identical to source", () => {
		ensureProjectAgents(root, RESOURCES_DIR);
		ensureProjectAgents(root, RESOURCES_DIR);
		for (const name of TFF_AGENT_NAMES) {
			const src = readFileSync(join(RESOURCES_DIR, "agents", `${name}.md`));
			const dst = readFileSync(join(root, ".pi", "agents", `${name}.md`));
			expect(Buffer.compare(src, dst)).toBe(0);
		}
	});

	it("restores tampered destination (write-always)", () => {
		ensureProjectAgents(root, RESOURCES_DIR);
		const dstPath = join(root, ".pi", "agents", "tff-executor.md");
		writeFileSync(dstPath, "tampered");
		ensureProjectAgents(root, RESOURCES_DIR);
		const src = readFileSync(join(RESOURCES_DIR, "agents", "tff-executor.md"));
		expect(Buffer.compare(src, readFileSync(dstPath))).toBe(0);
	});
});
