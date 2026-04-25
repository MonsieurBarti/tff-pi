import { describe, expect, it } from "vitest";
import { errnoCode } from "../../../../src/common/routing/fs-helpers.js";

describe("errnoCode", () => {
	it("returns string code on real ENOENT", () => {
		const err = Object.assign(new Error("nope"), { code: "ENOENT" });
		expect(errnoCode(err)).toBe("ENOENT");
	});
	it("returns undefined on plain Error without code", () => {
		expect(errnoCode(new Error("plain"))).toBeUndefined();
	});
	it("returns undefined on non-error inputs", () => {
		expect(errnoCode(null)).toBeUndefined();
		expect(errnoCode("oops")).toBeUndefined();
		expect(errnoCode(42)).toBeUndefined();
	});
	it("returns undefined when code is non-string", () => {
		const err = Object.assign(new Error("x"), { code: 7 });
		expect(errnoCode(err)).toBeUndefined();
	});
});
