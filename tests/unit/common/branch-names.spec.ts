import { describe, expect, it } from "vitest";
import {
	InvalidBranchName,
	assertValidBranchName,
	isValidBranchName,
} from "../../../src/common/branch-names.js";

describe("branch-names", () => {
	it.each([
		["main", true],
		["feature/x", true],
		["feature/M10-S05", true],
		["mb/lin-1234", true],
		["release/1.0.0", true],
		["hotfix_urgent", true],
		["a", true],
	])("accepts %s", (name, ok) => {
		expect(isValidBranchName(name as string)).toBe(ok);
	});

	it.each([
		["", "empty"],
		["-flag", "leading dash"],
		["bad name", "space"],
		["a;rm -rf", "semicolon"],
		["..", "pure traversal"],
		["../foo", "leading traversal"],
		["a/..", "trailing traversal"],
		["a/../b", "middle traversal"],
		[".", "pure dot"],
		["a//b", "double slash"],
		["/absolute", "absolute path"],
		["a/", "trailing slash"],
	])("rejects %s (%s)", (name, _label) => {
		expect(isValidBranchName(name as string)).toBe(false);
	});

	it("assertValidBranchName throws InvalidBranchName on bad input", () => {
		expect(() => assertValidBranchName("../x")).toThrow(InvalidBranchName);
	});

	it("assertValidBranchName is a no-op on good input", () => {
		expect(() => assertValidBranchName("feature/ok")).not.toThrow();
	});
});
