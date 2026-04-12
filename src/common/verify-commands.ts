import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Settings } from "./settings.js";

export interface VerifyCommand {
	name: string;
	command: string;
	source: "settings" | "ci" | "hooks" | "package.json";
}

export function detectVerifyCommands(root: string, settings: Settings): VerifyCommand[] {
	// 1. Explicit settings take precedence
	if (settings.verify_commands && settings.verify_commands.length > 0) {
		return settings.verify_commands.map((v) => ({
			name: v.name,
			command: v.command,
			source: "settings" as const,
		}));
	}

	// Auto-detection is opt-in only. Without explicit opt-in, do not
	// shell-execute commands sourced from CI YAML / hooks / package.json —
	// that would let a malicious PR achieve RCE via crafted workflow files.
	if (settings.verify_auto_detect !== true) {
		return [];
	}

	const commands: VerifyCommand[] = [];
	const seen = new Set<string>();

	function add(cmd: VerifyCommand): void {
		if (seen.has(cmd.command)) return;
		seen.add(cmd.command);
		commands.push(cmd);
	}

	// 2. GitHub Actions workflows
	const workflowDir = join(root, ".github", "workflows");
	if (existsSync(workflowDir)) {
		try {
			const files = readdirSync(workflowDir).filter(
				(f) => f.endsWith(".yml") || f.endsWith(".yaml"),
			);
			for (const file of files) {
				const content = readFileSync(join(workflowDir, file), "utf-8");
				const parsed = YAML.parse(content);
				if (parsed?.jobs) {
					for (const job of Object.values(parsed.jobs)) {
						const steps = (job as { steps?: unknown[] })?.steps;
						if (!Array.isArray(steps)) continue;
						for (const step of steps) {
							const run = (step as { run?: string })?.run;
							if (typeof run !== "string") continue;
							const trimmed = run.trim();
							if (isVerificationCommand(trimmed)) {
								add({
									name: inferName(trimmed),
									command: trimmed,
									source: "ci",
								});
							}
						}
					}
				}
			}
		} catch {
			// Best-effort
		}
	}

	// 3. Lefthook
	const lefthookPath = join(root, "lefthook.yml");
	if (existsSync(lefthookPath)) {
		try {
			const parsed = YAML.parse(readFileSync(lefthookPath, "utf-8"));
			for (const hookName of ["pre-commit", "pre-push"]) {
				const hook = parsed?.[hookName];
				if (!hook?.commands) continue;
				for (const cmd of Object.values(hook.commands)) {
					const run = (cmd as { run?: string })?.run;
					if (typeof run === "string") {
						const trimmed = run.trim();
						add({
							name: inferName(trimmed),
							command: trimmed,
							source: "hooks",
						});
					}
				}
			}
		} catch {
			// Best-effort
		}
	}

	// 4. Husky
	const huskyPreCommit = join(root, ".husky", "pre-commit");
	if (existsSync(huskyPreCommit)) {
		try {
			const content = readFileSync(huskyPreCommit, "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (
					trimmed &&
					!trimmed.startsWith("#") &&
					!trimmed.startsWith(".") &&
					isVerificationCommand(trimmed)
				) {
					add({
						name: inferName(trimmed),
						command: trimmed,
						source: "hooks",
					});
				}
			}
		} catch {
			// Best-effort
		}
	}

	// 5. package.json scripts fallback (only if nothing found yet)
	if (commands.length === 0) {
		const pkgPath = join(root, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				const scripts = pkg?.scripts;
				if (scripts && typeof scripts === "object") {
					for (const key of ["test", "lint", "typecheck", "check"]) {
						if (typeof scripts[key] === "string") {
							add({
								name: key,
								command: scripts[key],
								source: "package.json",
							});
						}
					}
				}
			} catch {
				// Best-effort
			}
		}
	}

	return commands;
}

const VERIFY_KEYWORDS = [
	"test",
	"vitest",
	"jest",
	"mocha",
	"pytest",
	"lint",
	"biome",
	"eslint",
	"prettier",
	"tsc",
	"typecheck",
	"type-check",
	"mypy",
	"check",
];

function isVerificationCommand(cmd: string): boolean {
	const lower = cmd.toLowerCase();
	return VERIFY_KEYWORDS.some((kw) => lower.includes(kw));
}

function inferName(cmd: string): string {
	const lower = cmd.toLowerCase();
	if (lower.includes("tsc") || lower.includes("typecheck") || lower.includes("type-check")) {
		return "typecheck";
	}
	if (lower.includes("lint") || lower.includes("biome") || lower.includes("eslint")) {
		return "lint";
	}
	if (lower.includes("test") || lower.includes("vitest") || lower.includes("jest")) {
		return "test";
	}
	return "check";
}
