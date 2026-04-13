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

function makePhaseCtx(root: string, sendMessage = vi.fn()): PhaseContext {
	return {
		root,
		slice: { id: "s1" },
		pi: { sendMessage },
	} as unknown as PhaseContext;
}

describe("runPhaseWithFreshContext", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `tff-phase-runner-${Date.now()}-${Math.random()}`);
		mkdirSync(join(root, ".tff"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns error when cmdCtx is null", async () => {
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "hi" }),
		};
		const phaseCtx = makePhaseCtx(root);

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx: null,
			phase: "execute",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("no command context");
		expect(mockModule.prepare).not.toHaveBeenCalled();
	});

	it("awaits newSession then delivers the prompt with triggerTurn and clears the disk stash", async () => {
		const { readPendingMessage } = await import("../../../src/common/phase.js");
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const cmdCtx = makeCmdCtx(newSessionMock);
		const sendMessage = vi.fn();
		const phaseCtx = makePhaseCtx(root, sendMessage);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "phase msg" }),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx,
			phase: "execute",
		});

		expect(result.success).toBe(true);
		expect(newSessionMock).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith(
			{ customType: "tff-phase", content: "phase msg", display: true },
			{ triggerTurn: true },
		);
		// Ordering: newSession must resolve BEFORE sendMessage fires.
		const newSessionOrder = newSessionMock.mock.invocationCallOrder[0] ?? 0;
		const sendOrder = sendMessage.mock.invocationCallOrder[0] ?? 0;
		expect(newSessionOrder).toBeLessThan(sendOrder);
		// Disk stash cleared on success.
		expect(readPendingMessage(root)).toBeNull();
	});

	it("stashes the message on disk before awaiting newSession (crash-recovery backstop)", async () => {
		const { readPendingMessage } = await import("../../../src/common/phase.js");
		let messageOnDiskDuringNewSession: string | null = null;
		const newSessionMock = vi.fn<NewSessionFn>().mockImplementation(async () => {
			messageOnDiskDuringNewSession = readPendingMessage(root);
			return { cancelled: false };
		});
		const cmdCtx = makeCmdCtx(newSessionMock);
		const phaseCtx = makePhaseCtx(root);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "phase msg" }),
		};

		await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx,
			phase: "execute",
		});

		expect(messageOnDiskDuringNewSession).toBe("phase msg");
	});

	it("leaves the disk stash on cancel and returns a retryable failure", async () => {
		const { readPendingMessage } = await import("../../../src/common/phase.js");
		const newSessionMock = makeNewSessionMock({ cancelled: true });
		const cmdCtx = makeCmdCtx(newSessionMock);
		const sendMessage = vi.fn();
		const phaseCtx = makePhaseCtx(root, sendMessage);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false, message: "phase msg" }),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx,
			phase: "plan",
		});

		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		expect(result.error).toContain("cancelled");
		expect(sendMessage).not.toHaveBeenCalled();
		// Disk stash preserved for /tff doctor recovery.
		expect(readPendingMessage(root)).toBe("phase msg");
	});

	it("skips newSession and sendMessage when prepare returns no message", async () => {
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const cmdCtx = makeCmdCtx(newSessionMock);
		const sendMessage = vi.fn();
		const phaseCtx = makePhaseCtx(root, sendMessage);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({ success: true, retry: false }),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx,
			phase: "ship",
		});

		expect(mockModule.prepare).toHaveBeenCalledOnce();
		expect(newSessionMock).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
	});

	it("skips newSession when prepare fails", async () => {
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const cmdCtx = makeCmdCtx(newSessionMock);
		const sendMessage = vi.fn();
		const phaseCtx = makePhaseCtx(root, sendMessage);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({
				success: false,
				retry: true,
				error: "bad validation",
				message: "should be ignored",
			}),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx,
			phase: "discuss",
		});

		expect(newSessionMock).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.error).toBe("bad validation");
	});

	it("releases lock even when prepare throws", async () => {
		const { readLock } = await import("../../../src/common/session-lock.js");
		const newSessionMock = makeNewSessionMock({ cancelled: false });
		const cmdCtx = makeCmdCtx(newSessionMock);
		const phaseCtx = makePhaseCtx(root);
		const mockModule: PhaseModule = {
			prepare: vi.fn().mockRejectedValue(new Error("boom")),
		};

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx,
			cmdCtx,
			phase: "verify",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("boom");
		expect(readLock(root)).toBeNull();
	});
});
