import { describe, expect, it, vi } from "vitest";

describe("runHeavyPhase", () => {
	it("surfaces newSession cancellation error via ui.notify", async () => {
		vi.doMock("../../../src/common/phase.js", () => ({
			runPhaseWithFreshContext: async () => ({
				success: false,
				retry: true,
				error: "New session was cancelled by a session_before_switch handler",
			}),
		}));

		const notify = vi.fn();
		const fakeCtx = {
			cmdCtx: { hasUI: true, ui: { notify } },
		};
		const fakePhaseCtx = {
			pi: { sendUserMessage: vi.fn() },
		};
		const fakeMod = {
			prepare: async () => ({ success: true, retry: false, message: "x" }),
		};

		const { runHeavyPhase } = await import("../../../src/commands/run-heavy-phase.js");
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		await runHeavyPhase(fakeCtx as any, "execute", fakeMod as any, fakePhaseCtx as any);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "error");

		vi.doUnmock("../../../src/common/phase.js");
	});

	it("falls back to sendUserMessage when no UI is present", async () => {
		vi.resetModules();
		vi.doMock("../../../src/common/phase.js", () => ({
			runPhaseWithFreshContext: async () => ({
				success: false,
				retry: false,
				error: "boom",
			}),
		}));

		const sendUserMessage = vi.fn();
		const fakeCtx = { cmdCtx: { hasUI: false } };
		const fakePhaseCtx = { pi: { sendUserMessage } };
		const fakeMod = {
			prepare: async () => ({ success: true, retry: false, message: "x" }),
		};

		const { runHeavyPhase } = await import("../../../src/commands/run-heavy-phase.js");
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		await runHeavyPhase(fakeCtx as any, "execute", fakeMod as any, fakePhaseCtx as any);

		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("boom"));

		vi.doUnmock("../../../src/common/phase.js");
	});
});
