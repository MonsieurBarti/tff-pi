import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

	it("awaits cmdCtx.newSession and delivers the prepared message via pi.sendUserMessage", async () => {
		const testRoot = mkdtempSync(join(tmpdir(), "tff-await-"));
		mkdirSync(join(testRoot, ".tff"), { recursive: true });
		const newSessionMock = vi.fn<NewSessionFn>().mockResolvedValue({ cancelled: false });
		const sendUserMessageMock = vi.fn();
		const fakeCmdCtx = { newSession: newSessionMock, hasUI: false };
		const fakePi = { sendUserMessage: sendUserMessageMock };
		const phaseModule = {
			prepare: async () => ({ success: true, retry: false, message: "go execute" }),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			phaseCtx: { root: testRoot, slice: { id: "s1" }, pi: fakePi } as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			cmdCtx: fakeCmdCtx as any,
			phase: "execute",
		});

		expect(result.success).toBe(true);
		expect(newSessionMock).toHaveBeenCalledOnce();
		expect(sendUserMessageMock).toHaveBeenCalledWith("go execute");
		// newSession must complete BEFORE sendUserMessage fires (the order that
		// triggers a turn in the new session, not the old one).
		const newSessionOrder = newSessionMock.mock.invocationCallOrder[0] ?? 0;
		const sendOrder = sendUserMessageMock.mock.invocationCallOrder[0] ?? 0;
		expect(newSessionOrder).toBeLessThan(sendOrder);

		rmSync(testRoot, { recursive: true, force: true });
	});

	it("propagates cancelled: true from newSession as a retryable failure and does not send the message", async () => {
		const testRoot = mkdtempSync(join(tmpdir(), "tff-cancel-"));
		mkdirSync(join(testRoot, ".tff"), { recursive: true });
		const sendUserMessageMock = vi.fn();
		const fakeCmdCtx = {
			newSession: async () => ({ cancelled: true }),
			hasUI: false,
		};
		const fakePi = { sendUserMessage: sendUserMessageMock };
		const phaseModule = {
			prepare: async () => ({ success: true, retry: false, message: "go" }),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			phaseCtx: { root: testRoot, slice: { id: "s1" }, pi: fakePi } as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			cmdCtx: fakeCmdCtx as any,
			phase: "execute",
		});

		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		expect(result.error).toContain("cancelled");
		expect(sendUserMessageMock).not.toHaveBeenCalled();

		rmSync(testRoot, { recursive: true, force: true });
	});
});
