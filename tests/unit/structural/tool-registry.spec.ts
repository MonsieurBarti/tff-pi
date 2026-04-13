import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTffContext } from "../../../src/common/context.js";
import { registerAllTools } from "../../../src/tools/index.js";

/**
 * Structural regression tests that prevent the class of bugs exposed by
 * tff_write_verification / tff_write_review being referenced in protocols
 * and agents without actually being registered as tools.
 *
 * These tests read the source of index.ts + every protocol and agent
 * markdown file, extract all `tff_*` / `tff-*` identifiers, and assert
 * that every identifier referenced in a resource is actually registered.
 *
 * They do NOT run the tools — they only inspect source text — so they
 * survive mocks and dependency injection.
 */

const SRC = join(process.cwd(), "src");
const INDEX = readFileSync(join(SRC, "index.ts"), "utf-8");
const ORCH = readFileSync(join(SRC, "orchestrator.ts"), "utf-8");

// Tool registrations now live in src/tools/<name>.ts; concatenate every
// tool module plus index.ts so the name-extractor finds them regardless
// of where they sit.
const TOOLS_DIR = join(SRC, "tools");
const TOOL_SOURCES = readdirSync(TOOLS_DIR)
	.filter((f) => f.endsWith(".ts"))
	.map((f) => readFileSync(join(TOOLS_DIR, f), "utf-8"))
	.join("\n");
const REGISTRATION_SRC = `${INDEX}\n${TOOL_SOURCES}`;

const RESOURCES_DIR = join(SRC, "resources");

function collectMarkdown(dir: string): { path: string; content: string }[] {
	const out: { path: string; content: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectMarkdown(full));
		} else if (entry.name.endsWith(".md")) {
			out.push({ path: full, content: readFileSync(full, "utf-8") });
		}
	}
	return out;
}

function extractToolNames(text: string): Set<string> {
	// Strip glob patterns like `tff_write_*` (prose references, not literal
	// tool names) before matching.
	const stripped = text.replace(/tff[_-][a-z0-9_-]*\*/g, "");
	// Matches tff_foo_bar OR tff-foo-bar style identifiers.
	const matches = stripped.match(/tff[_-][a-z][a-z0-9_-]*/g) ?? [];
	return new Set(matches);
}

function extractRegisteredTools(indexSrc: string): Set<string> {
	// Tools are defined via `name: "tff_..."` or `name: "tff-..."`.
	const names = new Set<string>();
	const pattern = /name:\s*"(tff[_-][a-z][a-z0-9_-]*)"/g;
	for (const match of indexSrc.matchAll(pattern)) {
		if (match[1]) names.add(match[1]);
	}
	return names;
}

function extractPhaseTools(orchSrc: string): Map<string, string[]> {
	// Parses the PHASE_TOOLS Record literal. Tight regex for the current shape;
	// if the shape changes this test must be updated intentionally.
	const blockMatch = orchSrc.match(
		/PHASE_TOOLS:\s*Record<Phase, string\[\]>\s*=\s*\{([\s\S]*?)\n\};/,
	);
	if (!blockMatch || !blockMatch[1]) throw new Error("PHASE_TOOLS block not found in orchestrator");
	const body = blockMatch[1];
	const map = new Map<string, string[]>();
	const rowPattern = /(\w+):\s*\[([^\]]+)\]/g;
	for (const row of body.matchAll(rowPattern)) {
		const phase = row[1];
		const toolsRaw = row[2] ?? "";
		const tools = [...toolsRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
		if (phase) map.set(phase, tools);
	}
	return map;
}

describe("tool registry consistency", () => {
	const registered = extractRegisteredTools(REGISTRATION_SRC);
	const resources = collectMarkdown(RESOURCES_DIR);

	// tff-fff_* tools come from an external extension (fff) and are never
	// registered in this repo's index.ts. Exclude them from the assertion.
	const EXTERNAL_PREFIXES = ["tff-fff_"];

	it("registers at least the core writer tools", () => {
		const expected = [
			"tff_write_spec",
			"tff_write_requirements",
			"tff_write_research",
			"tff_write_plan",
			"tff_write_verification",
			"tff_write_review",
			"tff_classify",
			"tff_ask_user",
			"tff_query_state",
			"tff_transition",
			"tff_create_project",
			"tff_add_remote",
			"tff_create_slice",
		];
		for (const name of expected) {
			expect(registered.has(name), `Expected tool ${name} to be registered in index.ts`).toBe(true);
		}
	});

	it("every tff_* / tff-* tool referenced in protocols or agents is registered", () => {
		for (const { path, content } of resources) {
			const referenced = extractToolNames(content);
			for (const name of referenced) {
				if (EXTERNAL_PREFIXES.some((p) => name.startsWith(p))) continue;
				expect(
					registered.has(name),
					`${path} references tool '${name}' but it is not registered in index.ts. Either register it or remove the reference.`,
				).toBe(true);
			}
		}
	});

	it("every protocol-referenced tool is actually wired into TOOL_REGISTRARS (runtime check)", () => {
		const registeredRuntime = new Set<string>();
		const mockPi = {
			registerTool: (def: { name: string }) => {
				registeredRuntime.add(def.name);
			},
		} as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;
		const ctx = createTffContext();
		registerAllTools(mockPi, ctx);

		for (const { path, content } of resources) {
			const referenced = extractToolNames(content);
			for (const name of referenced) {
				if (EXTERNAL_PREFIXES.some((p) => name.startsWith(p))) continue;
				expect(
					registeredRuntime.has(name),
					`${path} references tool '${name}' but it was not registered by registerAllTools. Either add it to src/tools/index.ts's TOOL_REGISTRARS array, or remove the reference.`,
				).toBe(true);
			}
		}
	});

	it("every tool in PHASE_TOOLS is registered (or is an external fff/external tool)", () => {
		const phaseTools = extractPhaseTools(ORCH);
		for (const [phase, tools] of phaseTools) {
			for (const name of tools) {
				if (EXTERNAL_PREFIXES.some((p) => name.startsWith(p))) continue;
				expect(
					registered.has(name),
					`PHASE_TOOLS.${phase} includes '${name}' but it is not registered in index.ts.`,
				).toBe(true);
			}
		}
	});
});

describe("phase completion path coverage", () => {
	const PHASES = ["discuss", "research", "plan", "execute", "verify", "review", "ship"] as const;
	const PHASE_FILES = Object.fromEntries(
		PHASES.map((p) => [p, readFileSync(join(SRC, "phases", `${p}.ts`), "utf-8")]),
	) as Record<(typeof PHASES)[number], string>;

	it("every phase module calls closePredecessorIfReady OR has no predecessor (discuss)", () => {
		for (const phase of PHASES) {
			if (phase === "discuss") continue; // no predecessor
			const src = PHASE_FILES[phase];
			expect(
				src.includes("closePredecessorIfReady"),
				`${phase}.ts must call closePredecessorIfReady so predecessor phase_run gets closed. Without it, phase_run stays 'started' forever and /tff doctor flags stalls.`,
			).toBe(true);
		}
	});

	it("every phase has SOME completion signal: either inline phase_complete/failed or a writer tool", () => {
		// Phases that emit inline (ship) OR rely on writer tools (everyone else).
		// If a phase has neither, it will stall forever.
		const WRITER_TOOL_BY_PHASE: Record<string, string> = {
			discuss: "tff_write_spec", // discuss has 3 writers (spec, requirements, classify); any completes
			research: "tff_write_research",
			plan: "tff_write_plan",
			verify: "tff_write_verification",
			review: "tff_write_review",
		};
		for (const phase of PHASES) {
			const src = PHASE_FILES[phase];
			const emitsInline =
				src.includes('type: "phase_complete"') || src.includes('type: "phase_failed"');
			const writerTool = WRITER_TOOL_BY_PHASE[phase];
			const hasWriterTool = writerTool ? REGISTRATION_SRC.includes(`name: "${writerTool}"`) : false;
			// Execute is the exception: no writer tool, but its completion is captured by
			// closePredecessorIfReady in verify.ts.
			if (phase === "execute") {
				expect(
					PHASE_FILES.verify.includes("closePredecessorIfReady"),
					"verify.ts must call closePredecessorIfReady to close out execute's phase_run.",
				).toBe(true);
				continue;
			}
			expect(
				emitsInline || hasWriterTool,
				`${phase}.ts has no completion signal. Add either an inline phase_complete/phase_failed emit ` +
					`OR register ${writerTool ?? "a writer tool"} that calls emitPhaseCompleteIfArtifactsReady.`,
			).toBe(true);
		}
	});
});
