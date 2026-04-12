import { describe, expect, it } from "vitest";
import { parsePrUrl } from "../../../src/common/gh-helpers.js";

describe("parsePrUrl", () => {
	it("parses a standard GitHub PR URL", () => {
		expect(parsePrUrl("https://github.com/owner/repo/pull/42")).toEqual({
			repo: "owner/repo",
			number: 42,
		});
	});

	it("parses with trailing slash", () => {
		expect(parsePrUrl("https://github.com/owner/repo/pull/42/")).toEqual({
			repo: "owner/repo",
			number: 42,
		});
	});

	it("parses with suffix like /files or /commits", () => {
		expect(parsePrUrl("https://github.com/owner/repo/pull/42/files")).toEqual({
			repo: "owner/repo",
			number: 42,
		});
	});

	it("returns null for invalid URLs", () => {
		expect(parsePrUrl("not a url")).toBeNull();
		expect(parsePrUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull();
		expect(parsePrUrl("https://github.com/owner/repo/issues/1")).toBeNull();
	});
});
