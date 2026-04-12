import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetActiveLevel, mockCompressLexical } = vi.hoisted(() => ({
	mockGetActiveLevel: vi.fn(),
	mockCompressLexical: vi.fn(),
}));

vi.mock("@the-forge-flow/ultra-compress-pi", () => ({
	getActiveLevel: mockGetActiveLevel,
	compressTextLexical: mockCompressLexical,
}));

import {
	compressIfEnabled,
	getCachedLevel,
	refreshCompressionLevel,
	resetCompressionForTest,
} from "../../../src/common/compress.js";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/common/settings.js";

function makeSettings(apply: Settings["compress"]["apply_to"] = undefined): Settings {
	return {
		...DEFAULT_SETTINGS,
		compress: {
			user_artifacts: false,
			...(apply ? { apply_to: apply } : {}),
		},
		ship: { ...DEFAULT_SETTINGS.ship },
	};
}

describe("compress helper", () => {
	beforeEach(() => {
		resetCompressionForTest();
		mockGetActiveLevel.mockReset();
		mockCompressLexical.mockReset().mockImplementation((input: string) => ({
			compressed: `[C]${input}`,
			before: input.length,
			after: input.length + 3,
		}));
	});

	it("refreshCompressionLevel caches the level", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("standard");
		await refreshCompressionLevel();
		expect(getCachedLevel()).toBe("standard");
	});

	it("refreshCompressionLevel falls back to 'off' on error", async () => {
		mockGetActiveLevel.mockRejectedValueOnce(new Error("no state"));
		await refreshCompressionLevel();
		expect(getCachedLevel()).toBe("off");
	});

	it("compressIfEnabled returns input unchanged when level is off", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("off");
		await refreshCompressionLevel();
		const out = compressIfEnabled("hello", "artifacts", makeSettings(["artifacts"]));
		expect(out).toBe("hello");
	});

	it("returns input unchanged when level is null (never refreshed)", () => {
		const out = compressIfEnabled("hello", "artifacts", makeSettings(["artifacts"]));
		expect(out).toBe("hello");
	});

	it("returns input unchanged when apply_to is undefined", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("standard");
		await refreshCompressionLevel();
		const out = compressIfEnabled("hello", "artifacts", makeSettings());
		expect(out).toBe("hello");
	});

	it("returns input unchanged when scope not in apply_to", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("standard");
		await refreshCompressionLevel();
		const out = compressIfEnabled("hello", "artifacts", makeSettings(["context_injection"]));
		expect(out).toBe("hello");
	});

	it("compresses when scope matches and level is active", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("standard");
		await refreshCompressionLevel();
		const out = compressIfEnabled("hello", "artifacts", makeSettings(["artifacts"]));
		expect(out).toBe("[C]hello");
	});

	it("compresses context_injection when configured", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("ultra");
		await refreshCompressionLevel();
		const out = compressIfEnabled(
			"content",
			"context_injection",
			makeSettings(["artifacts", "context_injection"]),
		);
		expect(out).toBe("[C]content");
	});

	it("returns input when compressTextLexical throws", async () => {
		mockGetActiveLevel.mockResolvedValueOnce("standard");
		await refreshCompressionLevel();
		mockCompressLexical.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		const out = compressIfEnabled("hello", "artifacts", makeSettings(["artifacts"]));
		expect(out).toBe("hello");
	});
});
