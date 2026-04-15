import { describe, expect, it } from "vitest";
import {
	type ParsedCommand,
	type Subcommand,
	VALID_SUBCOMMANDS,
	isValidSubcommand,
	parseSubcommand,
} from "../../../src/common/router.js";

describe("router", () => {
	describe("VALID_SUBCOMMANDS", () => {
		it("contains all required subcommands", () => {
			expect(VALID_SUBCOMMANDS).toEqual([
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
				"complete-milestone-merged",
				"complete-milestone-changes",
				"recover",
				"next",
				"status",
				"progress",
				"settings",
				"health",
				"help",
				"logs",
				"doctor",
			]);
		});
	});

	describe("parseSubcommand", () => {
		it("parses a bare subcommand", () => {
			const result = parseSubcommand("new");
			expect(result).toEqual({ subcommand: "new", args: [] });
		});

		it("parses a subcommand with a single arg", () => {
			const result = parseSubcommand("new task");
			expect(result).toEqual({ subcommand: "new", args: ["task"] });
		});

		it("parses a subcommand with multiple args", () => {
			const result = parseSubcommand("plan with multiple args");
			expect(result).toEqual({
				subcommand: "plan",
				args: ["with", "multiple", "args"],
			});
		});

		it("parses hyphenated subcommands", () => {
			const result = parseSubcommand("new-milestone M01");
			expect(result).toEqual({ subcommand: "new-milestone", args: ["M01"] });
		});

		it("returns help when given empty input", () => {
			const result = parseSubcommand("");
			expect(result).toEqual({ subcommand: "help", args: [] });
		});

		it("returns help when given only whitespace", () => {
			const result = parseSubcommand("   ");
			expect(result).toEqual({ subcommand: "help", args: [] });
		});

		it("trims whitespace from input", () => {
			const result = parseSubcommand("  status   ");
			expect(result).toEqual({ subcommand: "status", args: [] });
		});

		it("handles extra whitespace between args", () => {
			const result = parseSubcommand("discuss  topic   details");
			expect(result).toEqual({
				subcommand: "discuss",
				args: ["topic", "details"],
			});
		});
	});

	describe("isValidSubcommand", () => {
		it("returns true for valid subcommands", () => {
			expect(isValidSubcommand("new")).toBe(true);
			expect(isValidSubcommand("new-milestone")).toBe(true);
			expect(isValidSubcommand("help")).toBe(true);
			expect(isValidSubcommand("status")).toBe(true);
		});

		it("returns false for invalid subcommands", () => {
			expect(isValidSubcommand("invalid")).toBe(false);
			expect(isValidSubcommand("foo")).toBe(false);
			expect(isValidSubcommand("")).toBe(false);
		});
	});

	describe("ParsedCommand interface", () => {
		it("has correct shape", () => {
			const cmd: ParsedCommand = {
				subcommand: "new",
				args: ["arg1", "arg2"],
			};
			expect(cmd.subcommand).toBe("new");
			expect(cmd.args).toEqual(["arg1", "arg2"]);
		});
	});

	describe("Subcommand type", () => {
		it("is narrowed by isValidSubcommand", () => {
			const input: string = "new";
			if (isValidSubcommand(input)) {
				const subcommand: Subcommand = input;
				expect(subcommand).toBe("new");
			}
		});
	});
});
