import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUuidV4, tffHomeRoot } from "../../../src/common/project-home.js";

describe("project-home", () => {
	let savedTffHome: string | undefined;

	beforeEach(() => {
		savedTffHome = process.env.TFF_HOME;
		Reflect.deleteProperty(process.env, "TFF_HOME");
	});

	afterEach(() => {
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
	});

	describe("tffHomeRoot", () => {
		it("returns $HOME/.tff when TFF_HOME is unset", () => {
			expect(tffHomeRoot()).toBe(join(homedir(), ".tff"));
		});

		it("returns TFF_HOME when set", () => {
			process.env.TFF_HOME = "/tmp/custom-tff-home";
			expect(tffHomeRoot()).toBe("/tmp/custom-tff-home");
		});

		it("falls back to ~/.tff when TFF_HOME is empty string", () => {
			process.env.TFF_HOME = "";
			expect(tffHomeRoot()).toBe(join(homedir(), ".tff"));
		});
	});

	describe("isUuidV4", () => {
		it("accepts a canonical UUID v4", () => {
			expect(isUuidV4("018f4a2b-3c5d-4e8f-9012-345678901234")).toBe(true);
		});

		it("accepts uppercase hex", () => {
			expect(isUuidV4("018F4A2B-3C5D-4E8F-9012-345678901234")).toBe(true);
		});

		it("rejects UUID v1 (version nibble != 4)", () => {
			expect(isUuidV4("018f4a2b-3c5d-1e8f-9012-345678901234")).toBe(false);
		});

		it("rejects invalid variant nibble", () => {
			expect(isUuidV4("018f4a2b-3c5d-4e8f-7012-345678901234")).toBe(false);
		});

		it("rejects missing segments", () => {
			expect(isUuidV4("018f4a2b-3c5d-4e8f-9012")).toBe(false);
		});

		it("rejects empty string", () => {
			expect(isUuidV4("")).toBe(false);
		});

		it("rejects whitespace", () => {
			expect(isUuidV4("  018f4a2b-3c5d-4e8f-9012-345678901234  ")).toBe(false);
		});
	});
});
