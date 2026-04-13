// tests/unit/structural/commands.spec.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../../src/commands/registry.js";
import { VALID_SUBCOMMANDS } from "../../../src/common/router.js";

describe("COMMANDS registry", () => {
	// Weak direction: every registered key must be a valid subcommand.
	// Tightened in Task 14 to also assert every VALID_SUBCOMMANDS entry has a handler.
	it("only registers valid subcommands", () => {
		const validSet = new Set<string>(VALID_SUBCOMMANDS);
		const invalid = [...COMMANDS.keys()].filter((key) => !validSet.has(key));
		expect(invalid).toEqual([]);
	});

	it("has a handler for every VALID_SUBCOMMANDS entry", () => {
		const missing = VALID_SUBCOMMANDS.filter((sub) => !COMMANDS.has(sub));
		expect(missing).toEqual([]);
	});

	it("every run* export in src/commands is wired into COMMANDS (no orphans)", () => {
		const COMMANDS_DIR = join(process.cwd(), "src", "commands");
		// Files that legitimately do not define a runnable slash command:
		//   - registry.ts     : the registry itself
		//   - run-heavy-phase.ts : shared helper imported by phase commands
		//   - phase-guard.ts  : validator used by assertPhasePreconditions
		const HELPERS_ONLY = new Set(["registry.ts", "run-heavy-phase.ts", "phase-guard.ts"]);

		const registrySrc = readFileSync(join(COMMANDS_DIR, "registry.ts"), "utf-8");

		const orphans: string[] = [];
		for (const entry of readdirSync(COMMANDS_DIR)) {
			if (!entry.endsWith(".ts") || HELPERS_ONLY.has(entry)) continue;
			const src = readFileSync(join(COMMANDS_DIR, entry), "utf-8");
			const runMatches = [...src.matchAll(/export\s+async\s+function\s+(run[A-Z][A-Za-z0-9]*)/g)];
			if (runMatches.length === 0) {
				// file has no run* export — treat as helper, not an orphan
				continue;
			}
			// Map run* to subcommand name via the registry: if the registry imports
			// run<X> from this file, it's wired. If the file has a run* but no
			// registry entry imports it, it's an orphan.
			const importMatch = registrySrc.match(
				new RegExp(
					`import \\{[^}]*(run[A-Z][A-Za-z0-9]*)[^}]*\\} from "\\./${entry.replace(".ts", ".js")}"`,
				),
			);
			if (!importMatch) {
				orphans.push(entry);
			}
		}

		expect(
			orphans,
			`These command files export run* functions but are not imported by the registry — likely orphans. Either wire them into COMMANDS or delete the file: ${orphans.join(", ")}`,
		).toEqual([]);
	});
});
