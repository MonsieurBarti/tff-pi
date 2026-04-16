import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "../../../src/common/settings.js";

describe("settings.state_branch", () => {
	it("DEFAULT_SETTINGS has state_branch.enabled=false, auto_detect_rename=true", () => {
		expect(DEFAULT_SETTINGS.state_branch.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.state_branch.auto_detect_rename).toBe(true);
	});

	it("parseSettings reads state_branch.enabled=true", () => {
		const s = parseSettings("state_branch:\n  enabled: true\n");
		expect(s.state_branch.enabled).toBe(true);
		expect(s.state_branch.auto_detect_rename).toBe(true);
	});

	it("parseSettings reads auto_detect_rename=false", () => {
		const s = parseSettings("state_branch:\n  enabled: true\n  auto_detect_rename: false\n");
		expect(s.state_branch.auto_detect_rename).toBe(false);
	});

	it("parseSettings missing state_branch key -> defaults (enabled=false)", () => {
		const s = parseSettings("model_profile: balanced\n");
		expect(s.state_branch.enabled).toBe(false);
		expect(s.state_branch.auto_detect_rename).toBe(true);
	});

	it("parseSettings non-boolean enabled -> default false", () => {
		const s = parseSettings('state_branch:\n  enabled: "yes"\n');
		expect(s.state_branch.enabled).toBe(false);
	});

	it("parseSettings empty string -> defaults", () => {
		const s = parseSettings("");
		expect(s.state_branch.enabled).toBe(false);
		expect(s.state_branch.auto_detect_rename).toBe(true);
	});
});
