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

export async function dispatchSubAgent(
	pi: ExtensionAPI,
	_agentName: string,
	prompt: SubAgentPrompt,
	cwd?: string,
): Promise<SubAgentResult> {
	const task = buildSubagentTask(prompt);
	const args = ["-p", "--no-session", "--system-prompt", prompt.systemPrompt, task];
	const execOpts: { timeout: number; cwd?: string } = { timeout: 600_000 };
	if (cwd) execOpts.cwd = cwd;

	try {
		const result = await pi.exec("pi", args, execOpts);
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
