import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

export function buildSubagentTask(prompt: SubAgentPrompt): string {
	const toolsSection =
		prompt.tools.length > 0
			? `\n\n## Available TFF Tools\n\n${prompt.tools.map((t) => `- ${t}`).join("\n")}`
			: "";

	return ["## Task", "", prompt.userPrompt, toolsSection].join("\n");
}

const MAX_INLINE_TASK_LEN = 8000;

export async function dispatchSubAgent(
	pi: ExtensionAPI,
	_agentName: string,
	prompt: SubAgentPrompt,
	cwd?: string,
): Promise<SubAgentResult> {
	const task = buildSubagentTask(prompt);

	// Use temp files for system prompt and large tasks (matches sub-agents-pi pattern)
	const tempDir = join(tmpdir(), `tff-subagent-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });

	try {
		const args = ["-p", "--no-session"];

		// System prompt via temp file (--append-system-prompt adds to default prompt)
		const promptFile = join(tempDir, "system.md");
		writeFileSync(promptFile, prompt.systemPrompt);
		args.push("--append-system-prompt", promptFile);

		// Task inline or via @file for large prompts
		if (task.length > MAX_INLINE_TASK_LEN) {
			const taskFile = join(tempDir, "task.md");
			writeFileSync(taskFile, task);
			args.push(`@${taskFile}`);
		} else {
			args.push(task);
		}

		if (cwd) {
			args.unshift("--cwd", cwd);
		}

		const result = await pi.exec("pi", args, { timeout: 600_000 });
		return {
			success: result.code === 0,
			output: result.stdout || result.stderr || "",
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
