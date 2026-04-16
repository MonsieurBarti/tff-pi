import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	type Settings,
	parseSettings,
	serializeSettings,
} from "../../../src/common/settings.js";

describe("settings", () => {
	describe("DEFAULT_SETTINGS", () => {
		it("has model_profile balanced", () => {
			expect(DEFAULT_SETTINGS.model_profile).toBe("balanced");
		});

		it("has compress.user_artifacts false", () => {
			expect(DEFAULT_SETTINGS.compress.user_artifacts).toBe(false);
		});
	});

	describe("parseSettings", () => {
		it("parses valid YAML", () => {
			const yaml = "model_profile: quality\ncompress:\n  user_artifacts: true\n";
			const settings = parseSettings(yaml);
			expect(settings.model_profile).toBe("quality");
			expect(settings.compress.user_artifacts).toBe(true);
		});

		it("returns defaults for empty string", () => {
			const settings = parseSettings("");
			expect(settings).toEqual(DEFAULT_SETTINGS);
		});

		it("returns defaults for null/undefined-like input", () => {
			const settings = parseSettings("null");
			expect(settings).toEqual(DEFAULT_SETTINGS);
		});

		it("returns defaults for invalid YAML", () => {
			const settings = parseSettings(": invalid: yaml: [{{");
			expect(settings).toEqual(DEFAULT_SETTINGS);
		});

		it("merges partial settings with defaults", () => {
			const yaml = "model_profile: budget\n";
			const settings = parseSettings(yaml);
			expect(settings.model_profile).toBe("budget");
			expect(settings.compress.user_artifacts).toBe(false);
		});

		it("accepts all valid model_profile values", () => {
			for (const profile of ["quality", "balanced", "budget"] as const) {
				const settings = parseSettings(`model_profile: ${profile}\n`);
				expect(settings.model_profile).toBe(profile);
			}
		});
	});

	describe("test_command setting", () => {
		it("defaults to undefined when absent", () => {
			const s = parseSettings("model_profile: balanced");
			expect(s.test_command).toBeUndefined();
		});
		it("parses test_command string", () => {
			const s = parseSettings("test_command: bun test");
			expect(s.test_command).toBe("bun test");
		});
		it("parses disabled test_command", () => {
			const s = parseSettings("test_command: disabled");
			expect(s.test_command).toBe("disabled");
		});
	});

	describe("milestone_target_branch setting", () => {
		it("defaults to undefined when absent", () => {
			const s = parseSettings("model_profile: balanced");
			expect(s.milestone_target_branch).toBeUndefined();
		});
		it("parses milestone_target_branch string", () => {
			const s = parseSettings("milestone_target_branch: develop");
			expect(s.milestone_target_branch).toBe("develop");
		});
	});

	describe("ship.merge_method setting", () => {
		it("defaults ship.merge_method to squash", () => {
			const s = parseSettings("");
			expect(s.ship.merge_method).toBe("squash");
		});
		it("parses ship.merge_method rebase", () => {
			const s = parseSettings("ship:\n  merge_method: rebase");
			expect(s.ship.merge_method).toBe("rebase");
		});
		it("defaults ship.merge_method to squash when ship section missing", () => {
			const s = parseSettings("model_profile: quality");
			expect(s.ship.merge_method).toBe("squash");
		});
	});

	describe("verify_commands setting", () => {
		it("defaults to undefined when absent", () => {
			const s = parseSettings("model_profile: balanced");
			expect(s.verify_commands).toBeUndefined();
		});

		it("parses verify_commands array", () => {
			const yaml = `verify_commands:\n  - name: test\n    command: "bun test"\n  - name: lint\n    command: "bun run lint"`;
			const s = parseSettings(yaml);
			expect(s.verify_commands).toEqual([
				{ name: "test", command: "bun test" },
				{ name: "lint", command: "bun run lint" },
			]);
		});

		it("filters invalid entries from verify_commands", () => {
			const yaml = `verify_commands:\n  - name: test\n    command: "bun test"\n  - invalid: true`;
			const s = parseSettings(yaml);
			expect(s.verify_commands).toHaveLength(1);
		});
	});

	describe("verify_auto_detect setting", () => {
		it("defaults to undefined when absent", () => {
			const s = parseSettings("model_profile: balanced");
			expect(s.verify_auto_detect).toBeUndefined();
		});

		it("parses verify_auto_detect: true", () => {
			const s = parseSettings("verify_auto_detect: true");
			expect(s.verify_auto_detect).toBe(true);
		});

		it("parses verify_auto_detect: false", () => {
			const s = parseSettings("verify_auto_detect: false");
			expect(s.verify_auto_detect).toBe(false);
		});

		it("ignores non-boolean verify_auto_detect values", () => {
			const s = parseSettings("verify_auto_detect: yes");
			expect(s.verify_auto_detect).toBeUndefined();
		});
	});

	describe("compress.apply_to", () => {
		it("parses apply_to array with valid scopes", () => {
			const s = parseSettings("compress:\n  apply_to: [artifacts, context_injection]\n");
			expect(s.compress.apply_to).toEqual(["artifacts", "context_injection"]);
		});

		it("filters invalid scopes from apply_to", () => {
			const s = parseSettings("compress:\n  apply_to: [artifacts, bogus, phase_prompts]\n");
			expect(s.compress.apply_to).toEqual(["artifacts", "phase_prompts"]);
		});

		it("legacy user_artifacts=true maps to apply_to=[artifacts]", () => {
			const s = parseSettings("compress:\n  user_artifacts: true\n");
			expect(s.compress.apply_to).toEqual(["artifacts"]);
		});

		it("explicit apply_to wins over legacy user_artifacts", () => {
			const s = parseSettings(
				"compress:\n  user_artifacts: true\n  apply_to: [context_injection]\n",
			);
			expect(s.compress.apply_to).toEqual(["context_injection"]);
		});

		it("apply_to is undefined when neither apply_to nor user_artifacts is set", () => {
			const s = parseSettings("model_profile: balanced");
			expect(s.compress.apply_to).toBeUndefined();
		});

		it("accepts empty apply_to array", () => {
			const s = parseSettings("compress:\n  apply_to: []\n");
			expect(s.compress.apply_to).toEqual([]);
		});
	});

	describe("serializeSettings", () => {
		it("serializes settings to YAML string", () => {
			const yaml = serializeSettings(DEFAULT_SETTINGS);
			expect(typeof yaml).toBe("string");
			expect(yaml).toContain("model_profile");
			expect(yaml).toContain("balanced");
		});

		it("round-trips through parseSettings", () => {
			const original: Settings = {
				model_profile: "quality",
				compress: { user_artifacts: true },
				ship: { merge_method: "squash" },
				state_branch: { enabled: false, auto_detect_rename: true },
			};
			const yaml = serializeSettings(original);
			const parsed = parseSettings(yaml);
			// After parsing, user_artifacts=true triggers legacy mapping to apply_to: ["artifacts"]
			expect(parsed.model_profile).toBe(original.model_profile);
			expect(parsed.compress.user_artifacts).toBe(original.compress.user_artifacts);
			expect(parsed.compress.apply_to).toEqual(["artifacts"]);
			expect(parsed.ship).toEqual(original.ship);
		});

		it("serializes compress.user_artifacts", () => {
			const yaml = serializeSettings(DEFAULT_SETTINGS);
			expect(yaml).toContain("user_artifacts");
		});

		it("round-trips apply_to through serialize/parse", () => {
			const original: Settings = {
				model_profile: "balanced",
				compress: { user_artifacts: false, apply_to: ["artifacts", "phase_prompts"] },
				ship: { merge_method: "squash" },
				state_branch: { enabled: false, auto_detect_rename: true },
			};
			const yaml = serializeSettings(original);
			const parsed = parseSettings(yaml);
			expect(parsed.compress.apply_to).toEqual(["artifacts", "phase_prompts"]);
		});
	});
});
