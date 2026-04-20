import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { logException } from "./logger.js";
import type { Phase } from "./types.js";

export type AgentStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

/** Maximum byte length for a single captured bash tool-call output. */
export const MAX_OUTPUT_BYTES = 65536;

export interface AgentResult {
	status: AgentStatus;
	summary: string;
	evidence: string;
	taskId?: string | undefined;
	exitCode: number;
	error?: string | undefined;
}

export interface DispatchConfig {
	agent: string;
	task: string;
	cwd: string;
	artifacts?: { label: string; content: string }[] | undefined;
	model?: string | undefined;
	taskId?: string | undefined;
}

export interface DispatchBatch {
	mode: "single" | "parallel";
	tasks: DispatchConfig[];
	concurrency?: number | undefined;
	phase: Phase;
	sliceId?: string | undefined;
}

export interface DispatchResult {
	mode: "single" | "parallel";
	results: AgentResult[];
	capturedAt: string;
}

/**
 * Captured bash tool-call from a subagent's message stream.
 *
 * Typed against pi-ai's `ToolCall` + `ToolResultMessage` shapes. Bash output
 * does not carry structured exitCode/stdout/stderr — only ToolResultMessage.isError
 * is reliable. `outputText` is the concatenated TextContent from the tool result.
 */
export interface CapturedCall {
	toolName: "bash";
	/** Parallel-mode correlation; undefined in single mode. */
	taskId?: string | undefined;
	/** ToolCall.id, used for pairing with the matching ToolResultMessage. */
	toolCallId: string;
	input: { command: string; cwd?: string | undefined };
	/** From ToolResultMessage.isError. */
	isError: boolean;
	/** Concatenated TextContent items from ToolResultMessage.content. */
	outputText: string;
	/** From ToolResultMessage.timestamp. */
	timestamp: number;
}

/**
 * Input to a phase finalizer. Three fields only — phase-specific dependencies
 * (db/pi/slice/milestoneNumber/worktreePath) live in the closure's captured
 * scope, not on this argument surface. Keeps the dispatcher phase-agnostic.
 */
export interface FinalizeInput {
	root: string;
	result: DispatchResult;
	calls: CapturedCall[];
}

export type Finalizer = (ctx: FinalizeInput) => Promise<void>;

/**
 * Per-phase finalizer registry. Last-wins semantics — each phase.prepare()
 * registers a fresh closure; re-registration replaces silently. Module-level
 * Map; not persisted (crash recovery re-runs prepare() which re-registers).
 */
const finalizers = new Map<Phase, Finalizer>();

export function registerPhaseFinalizer(phase: Phase, fn: Finalizer): void {
	finalizers.set(phase, fn);
}

/** Test-only: retrieves the registered finalizer for a phase, if any. */
export function __getFinalizerForTest(phase: Phase): Finalizer | undefined {
	return finalizers.get(phase);
}

/** Test-only: clears all finalizer registrations. Prevents cross-test pollution. */
export function __resetFinalizersForTest(): void {
	finalizers.clear();
}

const TFF_DIR_PARTS = [".pi", ".tff"] as const;
const CONFIG_FILE = "dispatch-config.json";
const RESULT_FILE = "dispatch-result.json";

const DISPATCHER_PROMPT = `<DISPATCH-ONLY>
You are a dispatcher. Read .pi/.tff/dispatch-config.json. Make EXACTLY ONE
tool call to \`subagent\` with these arguments. Forward ONLY the fields listed
below — do NOT forward \`taskId\` (it is internal correlation metadata, not
part of pi-subagents' SubagentParams schema).

- SINGLE mode (mode == "single"):
    subagent({
      agent: <tasks[0].agent>,
      task: <tasks[0].task>,
      cwd: <tasks[0].cwd>,
      model: <tasks[0].model>          // omit field entirely if absent
    })

- PARALLEL mode (mode == "parallel"):
    subagent({
      tasks: <tasks>.map(t => {
        const item = { agent: t.agent, task: t.task, cwd: t.cwd };
        if (t.model) item.model = t.model;
        return item;                   // taskId NOT included
      }),
      concurrency: <concurrency>       // omit if absent
    })

After the tool returns, do NOT respond, do NOT call any other tool.
Output the literal text "DISPATCH_COMPLETE" and end your turn.
</DISPATCH-ONLY>`;

const STATUS_RE = /^STATUS:\s*(DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED)\s*$/m;
const EVIDENCE_RE = /^EVIDENCE:\s*(.+)$/m;

// Module-level idempotency guard: second call with the same ExtensionAPI
// instance is a no-op. Primary registration is at extension init
// (lifecycle.ts); this Set hardens against test harnesses and any future
// caller invoking twice per pi instance.
const registeredHandles: WeakSet<ExtensionAPI> = new WeakSet();

function tffDir(root: string): string {
	return join(root, ...TFF_DIR_PARTS);
}

function writeAtomic(path: string, body: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, body, "utf-8");
	renameSync(tmp, path);
}

function buildTaskBody(cfg: DispatchConfig): string {
	const sections: string[] = [];
	if (cfg.artifacts && cfg.artifacts.length > 0) {
		for (const a of cfg.artifacts) sections.push(`## ${a.label}\n${a.content}`);
	}
	sections.push(`## Task\n${cfg.task}`);
	return sections.join("\n\n");
}

export function prepareDispatch(root: string, batch: DispatchBatch): { message: string } {
	const dir = tffDir(root);
	mkdirSync(dir, { recursive: true });
	const resultPath = join(dir, RESULT_FILE);
	if (existsSync(resultPath)) {
		try {
			unlinkSync(resultPath);
		} catch {
			// ignore ENOENT race
		}
	}

	const persistedTasks = batch.tasks.map((t) => {
		const { artifacts: _artifacts, ...rest } = t;
		const copy: DispatchConfig = { ...rest, task: buildTaskBody(t) };
		return copy;
	});

	const persisted: {
		mode: "single" | "parallel";
		concurrency: number | undefined;
		phase: Phase;
		sliceId?: string;
		tasks: DispatchConfig[];
	} = {
		mode: batch.mode,
		concurrency: batch.concurrency,
		phase: batch.phase,
		tasks: persistedTasks,
	};
	if (batch.sliceId !== undefined) persisted.sliceId = batch.sliceId;
	writeAtomic(join(dir, CONFIG_FILE), JSON.stringify(persisted, null, 2));
	return { message: DISPATCHER_PROMPT };
}

interface MinimalMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
}

interface MinimalSingleResult {
	exitCode: number;
	error?: string;
	finalOutput?: string;
	messages?: MinimalMessage[];
}

function extractText(result: MinimalSingleResult): string {
	if (typeof result.finalOutput === "string" && result.finalOutput.length > 0) {
		return result.finalOutput;
	}
	const msgs = result.messages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m || m.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) {
			const text = m.content
				.filter(
					(p: unknown): p is { type: string; text: string } =>
						typeof p === "object" &&
						p !== null &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string",
				)
				.map((p) => p.text)
				.join("");
			if (text) return text;
		}
	}
	return "";
}

function parseSingleResult(result: MinimalSingleResult, taskId?: string): AgentResult {
	if (result.exitCode !== 0 || result.error) {
		return {
			status: "BLOCKED",
			summary: result.finalOutput ?? "",
			evidence: result.error ?? "non-zero exit",
			taskId,
			exitCode: result.exitCode,
			error: result.error,
		};
	}
	const text = extractText(result);
	const statusMatch = STATUS_RE.exec(text);
	if (!statusMatch) {
		return {
			status: "BLOCKED",
			summary: text,
			evidence: "malformed output",
			taskId,
			exitCode: result.exitCode,
		};
	}
	const status = statusMatch[1] as AgentStatus;
	const evidenceMatch = EVIDENCE_RE.exec(text);
	const evidence = evidenceMatch?.[1]?.trim() ?? status;
	return { status, summary: text, evidence, taskId, exitCode: result.exitCode };
}

function parseAgentResults(config: DispatchBatch, live: MinimalSingleResult[]): AgentResult[] {
	const out: AgentResult[] = [];
	if (config.mode === "single") {
		const first = live[0];
		if (!first) {
			out.push({
				status: "BLOCKED",
				summary: "",
				evidence: "missing single result",
				taskId: config.tasks[0]?.taskId,
				exitCode: -1,
			});
		} else {
			out.push(parseSingleResult(first, config.tasks[0]?.taskId));
		}
	} else {
		if (live.length !== config.tasks.length) {
			for (const t of config.tasks) {
				out.push({
					status: "BLOCKED",
					summary: "",
					evidence: "missing parallel result",
					taskId: t.taskId,
					exitCode: -1,
				});
			}
		} else {
			for (let i = 0; i < live.length; i++) {
				const r = live[i];
				const cfg = config.tasks[i];
				if (!r || !cfg) continue;
				out.push(parseSingleResult(r, cfg.taskId));
			}
		}
	}
	return out;
}

/**
 * One-pass walk of each result's message stream. For every assistant
 * `toolCall` whose `name === "bash"`, pair it with the first subsequent
 * `toolResult` sharing the same `toolCallId`. Output order matches the
 * chronological order of the `toolCall` entries in the stream.
 */
function extractBashCalls(config: DispatchBatch, live: MinimalSingleResult[]): CapturedCall[] {
	const out: CapturedCall[] = [];
	for (let i = 0; i < live.length; i++) {
		const result = live[i];
		if (!result) continue;
		const taskId = config.tasks[i]?.taskId;
		const messages = result.messages ?? [];
		const pending = new Map<string, { command: string; cwd?: string | undefined; index: number }>();
		const emitted = new Set<string>();
		// Preserve insertion order by walking once and building a list; pair on
		// toolResult arrival.
		const calls: CapturedCall[] = [];
		for (const m of messages) {
			if (m.role === "assistant" && Array.isArray(m.content)) {
				for (const part of m.content) {
					if (!part || typeof part !== "object") continue;
					const p = part as {
						type?: unknown;
						name?: unknown;
						id?: unknown;
						arguments?: unknown;
					};
					if (p.type !== "toolCall") continue;
					if (p.name !== "bash") continue;
					if (typeof p.id !== "string") continue;
					const args = (p.arguments ?? {}) as { command?: unknown; cwd?: unknown };
					const command = typeof args.command === "string" ? args.command : "";
					const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
					pending.set(p.id, { command, cwd, index: calls.length });
					// placeholder preserves ordering; will be filled when paired
					calls.push({
						toolName: "bash",
						taskId,
						toolCallId: p.id,
						input: cwd === undefined ? { command } : { command, cwd },
						isError: false,
						outputText: "",
						timestamp: 0,
					});
				}
			} else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
				const tcid = m.toolCallId;
				const slot = pending.get(tcid);
				if (!slot) continue;
				if (emitted.has(tcid)) continue;
				emitted.add(tcid);
				let outputText = "";
				if (Array.isArray(m.content)) {
					for (const part of m.content) {
						if (
							part &&
							typeof part === "object" &&
							(part as { type?: unknown }).type === "text" &&
							typeof (part as { text?: unknown }).text === "string"
						) {
							outputText += (part as { text: string }).text;
						}
					}
				}
				const originalByteLength = Buffer.byteLength(outputText, "utf8");
				if (originalByteLength > MAX_OUTPUT_BYTES) {
					// Truncate to MAX_OUTPUT_BYTES and append a diagnostic suffix.
					const truncated = Buffer.from(outputText, "utf8")
						.subarray(0, MAX_OUTPUT_BYTES)
						.toString("utf8")
						.replace(/\uFFFD$/, ""); // drop any split surrogate at boundary
					outputText = `${truncated}\n...[truncated: ${originalByteLength} bytes]`;
				}
				const entry = calls[slot.index];
				if (entry) {
					entry.isError = m.isError === true;
					entry.outputText = outputText;
					entry.timestamp = typeof m.timestamp === "number" ? m.timestamp : 0;
				}
			}
		}
		// Only include calls that actually paired; unpaired placeholders are
		// dropped so callers don't see synthetic zero-timestamp entries.
		for (const c of calls) {
			if (emitted.has(c.toolCallId)) out.push(c);
		}
	}
	return out;
}

function safeUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// ENOENT race or permission — best-effort cleanup
	}
}

export function registerDispatchHook(pi: ExtensionAPI): void {
	if (registeredHandles.has(pi)) return;
	registeredHandles.add(pi);
	pi.on("tool_result", async (event, ctx) => {
		let configPath: string | null = null;
		let resultPath: string | null = null;
		let finalizerRan = false;
		try {
			if ((event as { toolName?: string }).toolName !== "subagent") return;
			const ctxShape = ctx as { projectRoot?: string; cwd?: string } | undefined;
			const root = ctxShape?.projectRoot ?? ctxShape?.cwd;
			if (!root) return;
			const dir = tffDir(root);
			configPath = join(dir, CONFIG_FILE);
			resultPath = join(dir, RESULT_FILE);
			if (!existsSync(configPath)) return;
			const config = JSON.parse(readFileSync(configPath, "utf-8")) as DispatchBatch;
			const details = (event as { details?: unknown }).details as
				| { mode?: string; results?: MinimalSingleResult[] }
				| undefined;
			const live = details?.results ?? [];

			const agentResults = parseAgentResults(config, live);
			const capturedAt = new Date().toISOString();
			writeAtomic(
				resultPath,
				JSON.stringify({ mode: config.mode, results: agentResults, capturedAt }, null, 2),
			);

			const calls = extractBashCalls(config, live);

			const finalize = finalizers.get(config.phase);
			if (finalize) {
				finalizerRan = true;
				try {
					await finalize({
						root,
						result: { mode: config.mode, results: agentResults, capturedAt },
						calls,
					});
				} catch (err) {
					logException("subagent-dispatcher", err, {
						fn: "finalizer",
						cmd: config.phase,
					});
					try {
						pi.events.emit("tff:phase", {
							type: "phase_failed",
							phase: config.phase,
							sliceId: config.sliceId,
							error: err instanceof Error ? err.message : String(err),
						});
					} catch (emitErr) {
						logException("subagent-dispatcher", emitErr, {
							fn: "finalizer-emit",
						});
					}
				}
			}
		} catch (err) {
			logException("subagent-dispatcher", err, { fn: "tool-result-hook" });
		} finally {
			// Cleanup only when a finalizer was invoked (successful or threw).
			// Leaving the result file when no finalizer is registered preserves
			// S02's readDispatchResult (consume-once) semantics for phases not
			// yet migrated to the finalizer pattern.
			if (finalizerRan) {
				if (configPath) safeUnlink(configPath);
				if (resultPath) safeUnlink(resultPath);
			}
		}
		return undefined;
	});
}

export function readDispatchResult(root: string): DispatchResult | null {
	const path = join(tffDir(root), RESULT_FILE);
	if (!existsSync(path)) return null;
	let body: string;
	try {
		body = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	try {
		unlinkSync(path);
	} catch {
		// best-effort — caller observes stale file on next call (rare race)
	}
	try {
		return JSON.parse(body) as DispatchResult;
	} catch (err) {
		logException("subagent-dispatcher", err, {
			fn: "read-dispatch-result-parse",
		});
		return null;
	}
}
