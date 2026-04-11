import { spawnSync } from "node:child_process";
import { gitEnv } from "./git.js";
import type { VerifyCommand } from "./verify-commands.js";

export interface CommandResult {
	name: string;
	command: string;
	exitCode: number;
	passed: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface MechanicalReport {
	timestamp: string;
	commands: CommandResult[];
	allPassed: boolean;
}

const MAX_STDOUT_LINES = 200;
const MAX_STDERR_LINES = 100;

function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `... (${lines.length - maxLines} lines truncated)\n${lines.slice(-maxLines).join("\n")}`;
}

export async function runMechanicalVerification(
	commands: VerifyCommand[],
	cwd: string,
): Promise<MechanicalReport> {
	const results: CommandResult[] = [];

	for (const cmd of commands) {
		const start = Date.now();
		let exitCode = 0;
		let stdout = "";
		let stderr = "";

		const result = spawnSync(cmd.command, {
			cwd,
			encoding: "utf-8",
			shell: true,
			timeout: 300_000, // 5 minute timeout per command
			env: gitEnv(),
			maxBuffer: 10 * 1024 * 1024,
		});

		if (result.error) {
			exitCode = 1;
			stderr = result.error.message;
			stdout = result.stdout ?? "";
		} else {
			exitCode = result.status ?? (result.signal ? 1 : 0);
			stdout = result.stdout ?? "";
			stderr = result.stderr ?? "";
		}

		results.push({
			name: cmd.name,
			command: cmd.command,
			exitCode,
			passed: exitCode === 0,
			stdout: truncateLines(stdout, MAX_STDOUT_LINES),
			stderr: truncateLines(stderr, MAX_STDERR_LINES),
			durationMs: Date.now() - start,
		});
	}

	return {
		timestamp: new Date().toISOString(),
		commands: results,
		allPassed: results.every((r) => r.passed),
	};
}

export function formatMechanicalReport(report: MechanicalReport): string {
	const lines: string[] = [
		"# Mechanical Verification Report",
		"",
		`**Timestamp:** ${report.timestamp}`,
		`**Overall:** ${report.allPassed ? "PASS" : "FAIL"}`,
		"",
	];

	for (const cmd of report.commands) {
		const status = cmd.passed ? "PASS" : "FAIL";
		lines.push(`## ${cmd.name} — ${status}`);
		lines.push("");
		lines.push(`**Command:** \`${cmd.command}\``);
		lines.push(`**Exit code:** ${cmd.exitCode}`);
		lines.push(`**Duration:** ${cmd.durationMs}ms`);

		if (cmd.stdout.trim()) {
			lines.push("", "### stdout", "", "```", cmd.stdout.trim(), "```");
		}
		if (cmd.stderr.trim()) {
			lines.push("", "### stderr", "", "```", cmd.stderr.trim(), "```");
		}
		lines.push("");
	}

	return lines.join("\n");
}
