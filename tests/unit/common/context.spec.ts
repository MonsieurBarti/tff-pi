import { describe, expect, it } from "vitest";
import { createTffContext } from "../../../src/common/context.js";

describe("createTffContext", () => {
	it("initializes all mutable fields to null", () => {
		const ctx = createTffContext();

		expect(ctx.db).toBeNull();
		expect(ctx.projectRoot).toBeNull();
		expect(ctx.settings).toBeNull();
		expect(ctx.fffBridge).toBeNull();
		expect(ctx.perSliceLog).toBeNull();
		expect(ctx.tuiMonitor).toBeNull();
		expect(ctx.cmdCtx).toBeNull();
		expect(ctx.initError).toBeNull();
	});
});
