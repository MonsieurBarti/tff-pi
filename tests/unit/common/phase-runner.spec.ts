import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhaseContext, PhaseModule } from "../../../src/common/phase.js";
import { runPhaseWithFreshContext } from "../../../src/common/phase.js";

describe("runPhaseWithFreshContext", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `tff-phase-runner-${Date.now()}`);
		mkdirSync(join(root, ".tff"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns error when cmdCtx is null", async () => {
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "hi" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: null,
			phase: "execute",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("no command context");
		expect(mockModule.prepare).not.toHaveBeenCalled();
	});

	it("calls prepare, then newSession, then sendUserMessage on new pi", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newSessionMock = vi.fn().mockResolvedValue({ cancelled: false }) as any;
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const sendUserMessageMock = vi.fn();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newPi: any = { sendUserMessage: sendUserMessageMock };
		const getPi = vi.fn().mockReturnValue(newPi);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "phase msg" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
			getPi,
		});

		expect(mockModule.prepare).toHaveBeenCalledOnce();
		expect(newSessionMock).toHaveBeenCalledOnce();
		expect(getPi).toHaveBeenCalledOnce();
		expect(sendUserMessageMock).toHaveBeenCalledWith("phase msg");
		expect(result.success).toBe(true);
	});

	it("returns error when new pi is unavailable after newSession", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newSessionMock = vi.fn().mockResolvedValue({ cancelled: false }) as any;
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "msg" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
			getPi: () => null,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("pi reference unavailable");
	});

	it("skips newSession when prepare returns no message", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newSessionMock = vi.fn().mockResolvedValue({ cancelled: false }) as any;
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "ship",
		});

		expect(mockModule.prepare).toHaveBeenCalledOnce();
		expect(newSessionMock).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
	});

	it("skips newSession when prepare fails", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newSessionMock = vi.fn().mockResolvedValue({ cancelled: false }) as any;
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({
				success: false,
				retry: true,
				error: "bad validation",
				message: "should be ignored",
			}),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "discuss",
		});

		expect(newSessionMock).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.error).toBe("bad validation");
	});

	it("returns error when newSession is cancelled", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newSessionMock = vi.fn().mockResolvedValue({ cancelled: true }) as any;
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "hi" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("cancelled");
	});

	it("returns error on newSession timeout", async () => {
		const newSessionMock = vi
			.fn()
			.mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ cancelled: true }), 200)),
			);
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "hi" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "plan",
			timeoutMs: 50,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("timed out");
	});

	it("releases lock even when prepare throws", async () => {
		const { readLock } = await import("../../../src/common/session-lock.js");
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const newSessionMock = vi.fn().mockResolvedValue({ cancelled: false }) as any;
		const mockCmdCtx = { newSession: newSessionMock } as unknown as Parameters<
			typeof runPhaseWithFreshContext
		>[0]["cmdCtx"];
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockRejectedValue(new Error("boom")),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "verify",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("boom");
		expect(readLock(root)).toBeNull();
	});
});
