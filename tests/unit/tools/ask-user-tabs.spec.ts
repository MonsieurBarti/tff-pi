import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { makeUI } from "../../../src/tools/ask-user/ui.js";

// Pass-through theme so assertions can check plain text without ANSI noise.
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as const;

const W = 80;

describe("questionTabs rendering", () => {
	it("renders a single 32-char header without truncation at 80 cols", () => {
		const headers = ["X".repeat(32)];
		const [line] = makeUI(fakeTheme as never, W).questionTabs(headers, 0, new Set());
		expect(line).toBeDefined();
		expect(visibleWidth(line as string)).toBeLessThanOrEqual(W);
		expect(line).toContain("X".repeat(32));
	});

	it("renders two 32-char headers with all labels present at 80 cols", () => {
		const headers = ["X".repeat(32), "Y".repeat(32)];
		const [line] = makeUI(fakeTheme as never, W).questionTabs(headers, 0, new Set());
		expect(line).toBeDefined();
		expect(visibleWidth(line as string)).toBeLessThanOrEqual(W);
		// Each label's first few chars must appear — full 32 may or may not fit.
		expect(line).toMatch(/X{4,}/);
		expect(line).toMatch(/Y{4,}/);
	});

	it("renders three 32-char headers with every label visible (possibly truncated) at 80 cols", () => {
		const headers = ["X".repeat(32), "Y".repeat(32), "Z".repeat(32)];
		const [line] = makeUI(fakeTheme as never, W).questionTabs(headers, 0, new Set());
		expect(line).toBeDefined();
		expect(visibleWidth(line as string)).toBeLessThanOrEqual(W);
		expect(line).toMatch(/X{4,}/);
		expect(line).toMatch(/Y{4,}/);
		expect(line).toMatch(/Z{4,}/);
	});

	it("renders short headers verbatim (no truncation when total width fits)", () => {
		const headers = ["Tier", "Scope", "Approach"];
		const [line] = makeUI(fakeTheme as never, W).questionTabs(headers, 1, new Set([0]));
		expect(line).toBeDefined();
		expect(line).toContain("Tier");
		expect(line).toContain("Scope");
		expect(line).toContain("Approach");
		expect(line).not.toContain("…"); // no ellipsis when we fit
	});
});
