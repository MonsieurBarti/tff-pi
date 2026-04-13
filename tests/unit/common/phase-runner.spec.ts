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

	it("awaits cmdCtx.newSession with a setup callback that appends the prepared message", async () => {
		const testRoot = mkdtempSync(join(tmpdir(), "tff-await-"));
		mkdirSync(join(testRoot, ".tff"), { recursive: true });
		const calls: { setupCalled: boolean; appendedContent: string | null } = {
			setupCalled: false,
			appendedContent: null,
		};
		const fakeSessionManager = {
			appendMessage: async (msg: { role: string; content: string }) => {
				calls.appendedContent = msg.content;
			},
		};
		const fakeCmdCtx = {
			newSession: async (opts: {
				parentSession?: string;
				setup?: (sm: typeof fakeSessionManager) => Promise<void>;
			}) => {
				if (opts.setup) {
					calls.setupCalled = true;
					await opts.setup(fakeSessionManager);
				}
				return { cancelled: false };
			},
			hasUI: false,
		};
		const phaseModule = {
			prepare: async () => ({ success: true, retry: false, message: "go execute" }),
		};

		const { runPhaseWithFreshContext } = await import("../../../src/common/phase.js");
		const result = await runPhaseWithFreshContext({
			phaseModule,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			phaseCtx: { root: testRoot, slice: { id: "s1" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			cmdCtx: fakeCmdCtx as any,
			phase: "execute",
		});

		expect(result.success).toBe(true);
		expect(calls.setupCalled).toBe(true);
		expect(calls.appendedContent).toBe("go execute");

		rmSync(testRoot, { recursive: true, force: true });
	});

	it("propagates cancelled: true from newSession as a retryable failure", async () => {
		const testRoot = mkdtempSync(join(tmpdir(), "tff-cancel-"));
		mkdirSync(join(testRoot, ".tff"), { recursive: true });
		const fakeCmdCtx = {
			newSession: async () => ({ cancelled: true }),
			hasUI: false,
		};
		const phaseModule = {
			prepare: async () => ({ success: true, retry: false, message: "go" }),
		};

		const { runPhaseWithFreshContext } = await import("../../../src/common/phase.js");
		const result = await runPhaseWithFreshContext({
			phaseModule,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			phaseCtx: { root: testRoot, slice: { id: "s1" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			cmdCtx: fakeCmdCtx as any,
			phase: "execute",
		});

		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		expect(result.error).toContain("cancelled");

		rmSync(testRoot, { recursive: true, force: true });
	});
});
