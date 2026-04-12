import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createTffContext } from "../../../src/common/context.js";

describe("createTffContext", () => {
	it("initializes all mutable fields to null and stashes pi", () => {
		const pi = { events: { emit: vi.fn() } } as unknown as ExtensionAPI;
		const ctx = createTffContext(pi);

		expect(ctx.pi).toBe(pi);
		expect(ctx.db).toBeNull();
		expect(ctx.projectRoot).toBeNull();
		expect(ctx.settings).toBeNull();
		expect(ctx.fffBridge).toBeNull();
		expect(ctx.eventLogger).toBeNull();
		expect(ctx.tuiMonitor).toBeNull();
		expect(ctx.cmdCtx).toBeNull();
		expect(ctx.initError).toBeNull();
	});
});
