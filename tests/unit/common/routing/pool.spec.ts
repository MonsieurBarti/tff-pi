import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_IDS } from "../../../../src/common/routing/pool.js";

describe("DEFAULT_POOL_IDS", () => {
	it("review default is single tff-code-reviewer", () => {
		expect(DEFAULT_POOL_IDS.review).toEqual(["tff-code-reviewer"]);
	});
	it("execute default is tff-executor", () => {
		expect(DEFAULT_POOL_IDS.execute).toEqual(["tff-executor"]);
	});
	it("verify default is tff-verifier", () => {
		expect(DEFAULT_POOL_IDS.verify).toEqual(["tff-verifier"]);
	});
});
