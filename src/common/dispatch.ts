import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SubAgentPrompt {
	systemPrompt: string;
	userPrompt: string;
	tools: string[];
	label: string;
}

export interface SubAgentResult {
	success: boolean;
	output: string;
}

import type { SubAgentActivity } from "./types.js";
export type { SubAgentActivity } from "./types.js";

export function buildSubagentTask(prompt: SubAgentPrompt): string {
	const toolsSection =
		prompt.tools.length > 0
			? `\n\n## Available TFF Tools\n\n${prompt.tools.map((t) => `- ${t}`).join("\n")}`
			: "";

	return ["## Task", "", prompt.userPrompt, toolsSection].join("\n");
}

// Path to TFF's own extension entry point — loaded in child pi via --extension
const TFF_EXTENSION_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "..", "index.js");

interface NdjsonMessage {
	role: string;
	content: Array<{ type: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

function getPiInvocation(): { bin: string; args: string[] } {
	if (process.env.PI_BIN) {
		return { bin: process.env.PI_BIN, args: [] };
	}
	const scriptPath = process.argv[1];
	if (scriptPath && existsSync(scriptPath)) {
		return { bin: process.execPath, args: [scriptPath] };
	}
	return { bin: "pi", args: [] };
}

function getExtensionArgs(): string[] {
	const paths: string[] = [];
	if (existsSync(TFF_EXTENSION_PATH)) {
		paths.push(TFF_EXTENSION_PATH);
	}
	const bundled = process.env.TFF_BUNDLED_EXTENSION_PATHS ?? "";
	for (const p of bundled.split(delimiter)) {
		const trimmed = p.trim();
		if (trimmed) paths.push(trimmed);
	}
	return paths.flatMap((p) => ["--extension", p]);
}

function getFinalOutput(messages: NdjsonMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as NdjsonMessage | undefined;
		if (msg?.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) return part.text;
			}
		}
	}
	return "";
}

export async function dispatchSubAgent(
	_pi: unknown,
	_agentName: string,
	prompt: SubAgentPrompt,
	cwd?: string,
	onActivity?: (activity: SubAgentActivity) => void,
): Promise<SubAgentResult> {
	const task = buildSubagentTask(prompt);

	const tempDir = mkdtempSync(join(tmpdir(), "tff-subagent-"));
	const promptFile = join(tempDir, "system.md");
	writeFileSync(promptFile, prompt.systemPrompt, { encoding: "utf-8", mode: 0o600 });

	const piArgs: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		...getExtensionArgs(),
		"--append-system-prompt",
		promptFile,
		`Task: ${task}`,
	];

	const pi = getPiInvocation();
	const allArgs = [...pi.args, ...piArgs];
	const spawnCwd = cwd ?? process.cwd();

	const messages: NdjsonMessage[] = [];
	const startTime = Date.now();

	// Activity tracking state
	let currentTool: string | null = null;
	let currentToolArgs: Record<string, unknown> | null = null;
	const completedTools: string[] = [];
	let turns = 0;

	function emitActivity(): void {
		if (!onActivity) return;
		onActivity({
			currentTool,
			currentToolArgs,
			completedTools: [...completedTools],
			turns,
			elapsedMs: Date.now() - startTime,
		});
	}

	function processEvent(event: {
		type?: string;
		message?: NdjsonMessage;
		toolName?: string;
		args?: Record<string, unknown>;
	}): void {
		switch (event.type) {
			case "tool_execution_start":
				currentTool = event.toolName ?? "unknown";
				currentToolArgs = event.args ?? null;
				emitActivity();
				break;

			case "tool_execution_end":
				completedTools.push(currentTool ?? event.toolName ?? "unknown");
				currentTool = null;
				currentToolArgs = null;
				emitActivity();
				break;

			case "message_end":
				if (event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						turns++;
						emitActivity();
					}
				}
				break;
		}
	}

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(pi.bin, allArgs, {
				cwd: spawnCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						processEvent(JSON.parse(line));
					} catch {
						// Non-JSON line
					}
				}
			});

			proc.stderr.on("data", () => {
				// Captured but not used — stderr is noisy with extension logs
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						processEvent(JSON.parse(buffer));
					} catch {
						// ignore
					}
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			const timeout = setTimeout(() => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, 600_000);

			proc.on("close", () => clearTimeout(timeout));
		});

		const output = getFinalOutput(messages);

		return {
			success: exitCode === 0,
			output: output || (exitCode === 0 ? "completed" : "sub-agent failed"),
		};
	} catch (err) {
		return {
			success: false,
			output: err instanceof Error ? err.message : String(err),
		};
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	}
}
