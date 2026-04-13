// tests/unit/structural/commands.spec.ts
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
});
