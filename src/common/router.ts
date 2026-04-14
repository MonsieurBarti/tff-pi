export const VALID_SUBCOMMANDS = [
	"init",
	"new",
	"new-milestone",
	"discuss",
	"research",
	"plan",
	"execute",
	"verify",
	"ship",
	"ship-merged",
	"ship-changes",
	"complete-milestone",
	"recover",
	"next",
	"status",
	"progress",
	"settings",
	"health",
	"help",
	"logs",
	"doctor",
] as const;

export type Subcommand = (typeof VALID_SUBCOMMANDS)[number];

export interface ParsedCommand {
	subcommand: string;
	args: string[];
}

export function parseSubcommand(input: string): ParsedCommand {
	const trimmed = input.trim();

	if (!trimmed) {
		return { subcommand: "help", args: [] };
	}

	const parts = trimmed.split(/\s+/);
	const subcommand = parts[0] ?? "help";
	const args = parts.slice(1);

	return { subcommand, args };
}

export function isValidSubcommand(name: string): name is Subcommand {
	return VALID_SUBCOMMANDS.includes(name as Subcommand);
}
