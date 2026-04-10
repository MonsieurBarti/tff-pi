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
	return [
		"## Identity & Protocol",
		"",
		prompt.systemPrompt,
		"",
		"## Available Tools",
		"",
		prompt.tools.map((t) => `- ${t}`).join("\n"),
		"",
		"## Task",
		"",
		prompt.userPrompt,
	].join("\n");
}

export async function dispatchSubAgent(
	pi: ExtensionAPI,
	agentName: string,
	prompt: SubAgentPrompt,
): Promise<SubAgentResult> {
	const task = buildSubagentTask(prompt);
	const args = ["--print", "--no-input", "--agent", agentName, "--agent-scope", "both", task];

	try {
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
	}
}
