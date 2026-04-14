import { describe, expect, it } from "vitest";
import { StateBranchError, stateBranchName } from "../../../src/common/state-branch.js";

describe("stateBranchName", () => {
	it("prefixes with tff-state/", () => {
		expect(stateBranchName("main")).toBe("tff-state/main");
	});
	it("preserves slashes in code branch names", () => {
		expect(stateBranchName("feature/M10")).toBe("tff-state/feature/M10");
	});
	it("handles ticket-style names (mb/lin-1234)", () => {
		expect(stateBranchName("mb/lin-1234-portable-state")).toBe(
			"tff-state/mb/lin-1234-portable-state",
		);
	});
});

describe("StateBranchError", () => {
	it("has a .name of StateBranchError", () => {
		const e = new StateBranchError("boom");
		expect(e.name).toBe("StateBranchError");
		expect(e).toBeInstanceOf(Error);
	});
});
