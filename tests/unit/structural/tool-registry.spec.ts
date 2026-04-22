import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTffContext } from "../../../src/common/context.js";
import { TFF_AGENT_NAMES } from "../../../src/common/subagent-agents.js";
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

	// Tools from external PI extensions (fff, camoufox) are never
	// registered in this repo's index.ts. Exclude them from the assertion.
	const EXTERNAL_PREFIXES = ["tff-fff_", "tff-search_", "tff-fetch_"];

	// pi-subagents agent names (e.g. tff-executor, tff-code-reviewer) match the
	// `tff-*` regex but are agent identifiers, not tool names. Exclude them.
	const AGENT_NAMES: ReadonlySet<string> = new Set<string>(TFF_AGENT_NAMES);
	// Tool names that used to be registered but were deliberately deleted.
	// Protocols / agents may mention them in narrative prose ("do NOT call X;
	// it no longer exists") to steer subagents away — that is expected and
	// should not trigger the consistency check.
	const DELETED_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
		"tff_checkpoint",
		"tff_execute_done",
	]);
	const isExcluded = (name: string) =>
		EXTERNAL_PREFIXES.some((p) => name.startsWith(p)) ||
		AGENT_NAMES.has(name) ||
		DELETED_TOOL_NAMES.has(name);

	it("registers at least the core writer tools", () => {
		const expected = [
			"tff_write_spec",
			"tff_write_requirements",
			"tff_write_research",
			"tff_write_plan",
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
				if (isExcluded(name)) continue;
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
				if (isExcluded(name)) continue;
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
				if (isExcluded(name)) continue;
				expect(
					registered.has(name),
					`PHASE_TOOLS.${phase} includes '${name}' but it is not registered in index.ts.`,
				).toBe(true);
			}
		}
	});

	it("tff_write_verification, tff_write_pr, tff_write_review are no longer registered (M01-S03 T07, M01-S04 T04)", () => {
		const registeredRuntime = new Set<string>();
		const mockPi = {
			registerTool: (def: { name: string }) => {
				registeredRuntime.add(def.name);
			},
		} as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;
		const ctx = createTffContext();
		registerAllTools(mockPi, ctx);
		expect(registeredRuntime.has("tff_write_verification")).toBe(false);
		expect(registeredRuntime.has("tff_write_pr")).toBe(false);
		expect(registeredRuntime.has("tff_write_review")).toBe(false);
		// Also assert the static-source extractor agrees — catches accidental
		// re-addition through import-side-effects.
		expect(registered.has("tff_write_verification")).toBe(false);
		expect(registered.has("tff_write_pr")).toBe(false);
		expect(registered.has("tff_write_review")).toBe(false);
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

	it("every phase has SOME completion signal: inline emit, stateless finalizer, or writer tool", () => {
		// Phases that emit inline (ship) OR rely on writer tools (discuss/research/plan)
		// OR have their completion in the stateless finalizer bundle
		// (execute/verify/review). If none of the three, the phase stalls.
		const WRITER_TOOL_BY_PHASE: Record<string, string> = {
			discuss: "tff_write_spec", // discuss has 3 writers (spec, requirements, classify); any completes
			research: "tff_write_research",
			plan: "tff_write_plan",
		};
		const FINALIZERS_SRC = readFileSync(join(SRC, "phases", "finalizers.ts"), "utf-8");
		for (const phase of PHASES) {
			const src = PHASE_FILES[phase];
			const emitsInline =
				src.includes('type: "phase_complete"') || src.includes('type: "phase_failed"');
			const finalizerEmits =
				FINALIZERS_SRC.includes(`phase: "${phase}"`) &&
				(FINALIZERS_SRC.includes('type: "phase_complete"') ||
					FINALIZERS_SRC.includes('type: "phase_failed"'));
			const writerTool = WRITER_TOOL_BY_PHASE[phase];
			const hasWriterTool = writerTool ? REGISTRATION_SRC.includes(`name: "${writerTool}"`) : false;
			// Execute is the exception in the simplest sense: its completion comes
			// from the stateless finalizer in finalizers.ts, AND verify.ts must
			// still call closePredecessorIfReady to cover the no-diff re-entry case.
			if (phase === "execute") {
				expect(
					PHASE_FILES.verify.includes("closePredecessorIfReady"),
					"verify.ts must call closePredecessorIfReady to close out execute's phase_run.",
				).toBe(true);
			}
			expect(
				emitsInline || finalizerEmits || hasWriterTool,
				`${phase}.ts has no completion signal. Add either an inline phase_complete/phase_failed emit, ` +
					`a stateless finalizer in finalizers.ts, OR register ${writerTool ?? "a writer tool"}.`,
			).toBe(true);
		}
	});

	it("phase dispatches use mode:'parallel' only (pi-subagents single-mode agent-discovery bug)", () => {
		// pi-subagents' findNearestProjectRoot (node_modules/pi-subagents/agents.ts)
		// stops walking up at the first directory containing ANY .pi/, not .pi/agents/.
		// Our worktrees have their own .pi/ (for .tff symlink + state), so top-level
		// cwd passed in SINGLE mode makes agent discovery stop inside the worktree
		// and miss the repo-root .pi/agents/ where tff-verifier/tff-executor/etc.
		// live. PARALLEL mode uses per-task cwd only; agent discovery falls back
		// to ctx.cwd (parent session / repo root). Enforce the invariant so we
		// don't regress to SINGLE mode accidentally.
		const PHASES_WITH_DISPATCH = ["execute", "verify", "review"] as const;
		for (const phase of PHASES_WITH_DISPATCH) {
			const src = readFileSync(join(SRC, "phases", `${phase}.ts`), "utf-8");
			const dispatchCallIdx = src.indexOf("prepareDispatch(");
			expect(dispatchCallIdx, `${phase}.ts should call prepareDispatch`).toBeGreaterThan(-1);
			const tailFromCall = src.slice(dispatchCallIdx, dispatchCallIdx + 400);
			expect(
				tailFromCall,
				`${phase}.ts prepareDispatch must use mode: "parallel" (SINGLE mode tickles pi-subagents' agent-discovery bug when cwd points at a worktree)`,
			).toMatch(/mode:\s*"parallel"/);
			expect(tailFromCall, `${phase}.ts prepareDispatch must NOT use mode: "single"`).not.toMatch(
				/mode:\s*"single"/,
			);
		}

		// finalizers.ts re-dispatches (execute wave 2+). Same invariant.
		const finalizersSrc = readFileSync(join(SRC, "phases", "finalizers.ts"), "utf-8");
		const finalizerDispatchIdx = finalizersSrc.indexOf("prepareDispatch(");
		if (finalizerDispatchIdx > -1) {
			const tail = finalizersSrc.slice(finalizerDispatchIdx, finalizerDispatchIdx + 400);
			expect(tail, 'finalizers.ts prepareDispatch must use mode: "parallel"').toMatch(
				/mode:\s*"parallel"/,
			);
		}
	});
});
