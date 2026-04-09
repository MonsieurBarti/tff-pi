import { describe, expect, it } from "vitest";
import type { ExtensionConfig, ExtensionState, ToolResultDetails } from "../../src/types.js";

describe("types", () => {
	it("should define ExtensionConfig", () => {
		const config: ExtensionConfig = {
			enabled: true,
		};
		expect(config.enabled).toBe(true);
	});

	it("should define ExtensionState", () => {
		const state: ExtensionState = {
			initialized: false,
			config: {
				enabled: true,
			},
		};
		expect(state.initialized).toBe(false);
		expect(state.config.enabled).toBe(true);
	});

	it("should define ToolResultDetails", () => {
		const details: ToolResultDetails = {
			action: "list",
			items: [],
		};
		expect(details.action).toBe("list");
		expect(details.items).toEqual([]);
	});
});
