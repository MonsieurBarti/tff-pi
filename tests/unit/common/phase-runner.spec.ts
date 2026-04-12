import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhaseContext, PhaseModule } from "../../../src/common/phase.js";
import { runPhaseWithFreshContext } from "../../../src/common/phase.js";

type NewSessionResult = { cancelled: boolean };
type NewSessionFn = (options?: unknown) => Promise<NewSessionResult>;

function makeNewSessionMock(result: NewSessionResult) {
	return vi.fn<NewSessionFn>().mockResolvedValue(result);
}

function makeCmdCtx(
	newSessionMock: ReturnType<typeof makeNewSessionMock>,
): Parameters<typeof runPhaseWithFreshContext>[0]["cmdCtx"] {
	return { newSession: newSessionMock } as unknown as Parameters<
		typeof runPhaseWithFreshContext
	>[0]["cmdCtx"];
}

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

	it("calls prepare, writes pending message to disk, then newSession", async () => {
		const { readPendingMessage } = await import("../../../src/common/phase.js");

		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const mockCmdCtx = makeCmdCtx(newSessionMock);
		let messageAtNewSession: string | null = null;
		newSessionMock.mockImplementation(async () => {
			// Snapshot disk state at the moment newSession is called
			messageAtNewSession = readPendingMessage(root);
			return { cancelled: false };
		});
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "phase msg" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
		});

		expect(mockModule.prepare).toHaveBeenCalledOnce();
		expect(messageAtNewSession).toBe("phase msg");
		expect(newSessionMock).toHaveBeenCalledOnce();
		expect(result.success).toBe(true);
	});

	it("clears pending message on disk if newSession is cancelled", async () => {
		const { readPendingMessage } = await import("../../../src/common/phase.js");

		const newSessionMock = makeNewSessionMock({ cancelled: true });
		const mockCmdCtx = makeCmdCtx(newSessionMock);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "phase msg" }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "plan",
		});

		expect(readPendingMessage(root)).toBeNull();
	});

	it("skips newSession when prepare returns no message", async () => {
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const mockCmdCtx = makeCmdCtx(newSessionMock);
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
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const mockCmdCtx = makeCmdCtx(newSessionMock);
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
		const newSessionMock = makeNewSessionMock({ cancelled: true });
		const mockCmdCtx = makeCmdCtx(newSessionMock);
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
			.fn<NewSessionFn>()
			.mockImplementation(
				() =>
					new Promise<NewSessionResult>((resolve) =>
						setTimeout(() => resolve({ cancelled: true }), 200),
					),
			);
		const mockCmdCtx = makeCmdCtx(newSessionMock);
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
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const mockCmdCtx = makeCmdCtx(newSessionMock);
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
