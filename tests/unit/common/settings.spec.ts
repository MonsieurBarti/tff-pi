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
