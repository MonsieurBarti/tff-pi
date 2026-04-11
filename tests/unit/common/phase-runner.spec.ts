import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPhaseWithFreshContext } from "../../../src/common/phase.js";
import type { PhaseContext, PhaseModule } from "../../../src/common/phase.js";
import type { SessionLock } from "../../../src/common/session-lock.js";

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
			run: vi.fn().mockResolvedValue({ success: true, retry: false }),
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
		expect(mockModule.run).not.toHaveBeenCalled();
	});

	it("calls newSession then runs the phase module", async () => {
		const mockCmdCtx = {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as ExtensionCommandContext;
		const mockModule: PhaseModule = {
			run: vi.fn().mockResolvedValue({ success: true, retry: false }),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
		});

		expect(mockCmdCtx.newSession).toHaveBeenCalledOnce();
		expect(mockModule.run).toHaveBeenCalledWith(mockCtx);
		expect(result.success).toBe(true);
	});

	it("returns error when newSession is cancelled", async () => {
		const mockCmdCtx = {
			newSession: vi.fn().mockResolvedValue({ cancelled: true }),
		} as unknown as ExtensionCommandContext;
		const mockModule: PhaseModule = { run: vi.fn() };
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		const result = await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("cancelled");
		expect(mockModule.run).not.toHaveBeenCalled();
	});

	it("returns error on newSession timeout", async () => {
		const mockCmdCtx = {
			newSession: vi
				.fn()
				.mockImplementation(
					() => new Promise((resolve) => setTimeout(() => resolve({ cancelled: true }), 200)),
				),
		} as unknown as ExtensionCommandContext;
		const mockModule: PhaseModule = { run: vi.fn() };
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

	it("acquires and releases lock around phase execution", async () => {
		const { readLock } = await import("../../../src/common/session-lock.js");
		const mockCmdCtx = {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as ExtensionCommandContext;
		const captured: { lock: SessionLock | null } = { lock: null };
		const mockModule: PhaseModule = {
			run: vi.fn().mockImplementation(() => {
				captured.lock = readLock(root);
				return { success: true, retry: false };
			}),
		};
		const mockCtx = { root, slice: { id: "s1" } } as unknown as PhaseContext;

		await runPhaseWithFreshContext({
			phaseModule: mockModule,
			phaseCtx: mockCtx,
			cmdCtx: mockCmdCtx,
			phase: "execute",
		});

		expect(captured.lock).not.toBeNull();
		expect(captured.lock?.phase).toBe("execute");
		expect(readLock(root)).toBeNull();
	});

	it("releases lock even when phase throws", async () => {
		const { readLock } = await import("../../../src/common/session-lock.js");
		const mockCmdCtx = {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as ExtensionCommandContext;
		const mockModule: PhaseModule = {
			run: vi.fn().mockRejectedValue(new Error("boom")),
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
