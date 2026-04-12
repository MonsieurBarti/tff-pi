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

	describe("ship.auto_merge setting", () => {
		it("parses ship.auto_merge as boolean (default false)", () => {
			const s = parseSettings("ship:\n  auto_merge: true");
			expect(s.ship.auto_merge).toBe(true);
		});
		it("defaults ship.auto_merge to false", () => {
			const s = parseSettings("");
			expect(s.ship.auto_merge).toBe(false);
		});
		it("defaults ship.auto_merge to false when ship section missing", () => {
			const s = parseSettings("model_profile: quality");
			expect(s.ship.auto_merge).toBe(false);
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
				ship: { auto_merge: false },
			};
			const yaml = serializeSettings(original);
			const parsed = parseSettings(yaml);
			expect(parsed).toEqual(original);
		});

		it("serializes compress.user_artifacts", () => {
			const yaml = serializeSettings(DEFAULT_SETTINGS);
			expect(yaml).toContain("user_artifacts");
		});
	});
});
