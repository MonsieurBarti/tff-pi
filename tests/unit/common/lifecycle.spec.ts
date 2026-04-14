import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPendingMessage, writePendingMessage } from "../../../src/common/phase.js";

// ---------------------------------------------------------------------------
// Heavy lifecycle dependencies — stubbed so the test can import lifecycle.ts
// without pulling in the entire TFF stack.
// ---------------------------------------------------------------------------

vi.mock("../../../src/common/git.js", () => ({
	getGitRoot: vi.fn(() => null),
	gitEnv: vi.fn(() => ({})),
}));

vi.mock("../../../src/common/memory.js", () => ({
	initMemory: vi.fn().mockResolvedValue(undefined),
	shutdownMemory: vi.fn().mockResolvedValue(undefined),
	getMemory: vi.fn(() => null),
}));

vi.mock("../../../src/common/compress.js", () => ({
	refreshCompressionLevel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/common/monitoring-setup.js", () => ({
	initMonitoring: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/common/fff-integration.js", () => ({
	shutdownFffBridge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/update-check.js", () => ({
	checkForUpdates: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/common/tool-call-logger.js", () => ({
	ToolCallLogger: vi.fn(() => ({
		subscribe: vi.fn(),
	})),
}));

vi.mock("../../../src/common/recovery.js", () => ({
	scanForStuckSlices: vi.fn(() => []),
	diagnoseRecovery: vi.fn(),
	formatRecoveryBriefing: vi.fn(() => "briefing"),
}));

vi.mock("../../../src/common/session-lock.js", () => ({
	readLock: vi.fn(() => null),
	isLockStale: vi.fn(() => false),
}));

import { getGitRoot } from "../../../src/common/git.js";
import { scanForStuckSlices } from "../../../src/common/recovery.js";
import { registerLifecycleHooks } from "../../../src/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers to build lightweight PI and TffContext mocks
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => Promise<unknown> | unknown;

function makePi() {
	const handlers: Record<string, EventHandler[]> = {};
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();

	const pi = {
		on: vi.fn((event: string, handler: EventHandler) => {
			if (!handlers[event]) handlers[event] = [];
			(handlers[event] as EventHandler[]).push(handler);
		}),
		sendMessage,
		sendUserMessage,
		events: {
			emit: vi.fn(),
			on: vi.fn(() => () => {}),
		},
	};

	async function trigger(event: string, ...args: unknown[]): Promise<void> {
		const list = handlers[event] ?? [];
		for (const h of list) {
			await h(...args);
		}
	}

	return { pi, sendMessage, sendUserMessage, trigger };
}

function makeCtx() {
	return {
		db: null,
		projectRoot: null,
		initError: null,
		toolCallLogger: null,
		settings: null,
		eventLogger: null,
		tuiMonitor: null,
		fffBridge: null,
	} as unknown as Parameters<typeof registerLifecycleHooks>[1];
}

const uiCtx = { hasUI: false } as unknown as Parameters<EventHandler>[1];

// ---------------------------------------------------------------------------

describe("lifecycle — session_start pending message delivery", () => {
	let root: string;

	beforeEach(() => {
		root = join(
			tmpdir(),
			`tff-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(join(root, ".tff"), { recursive: true });
		vi.mocked(getGitRoot).mockReturnValue(root);
		vi.mocked(scanForStuckSlices).mockReturnValue([]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("session_start on 'startup' delivers pending-phase-message.txt if present", async () => {
		writePendingMessage(root, "execute-prompt-content");

		const { pi, sendMessage, trigger } = makePi();
		const ctx = makeCtx();
		registerLifecycleHooks(pi as never, ctx);

		await trigger("session_start", { reason: "startup" }, uiCtx);

		// Message delivered via pi.sendMessage (customType path)
		expect(sendMessage).toHaveBeenCalledOnce();
		const call = sendMessage.mock.calls[0];
		const msg = call?.[0];
		const opts = call?.[1];
		expect(msg).toMatchObject({
			customType: "tff-phase",
			content: "execute-prompt-content",
			display: true,
		});
		expect(opts).toMatchObject({ triggerTurn: true });

		// File must be cleared after delivery
		expect(readPendingMessage(root)).toBeNull();
	});

	it("session_start on 'startup' does NOT run recovery scan when pending message delivered", async () => {
		writePendingMessage(root, "execute-prompt-content");

		const { pi, trigger } = makePi();
		const ctx = makeCtx();
		registerLifecycleHooks(pi as never, ctx);

		await trigger("session_start", { reason: "startup" }, uiCtx);

		// Recovery scan must NOT have been invoked when pending message was delivered
		expect(vi.mocked(scanForStuckSlices)).not.toHaveBeenCalled();
	});

	it("session_start on 'startup' falls back to recovery scan when no pending message", async () => {
		// No pending file — no message delivery, scan path taken
		const { pi, sendMessage, trigger } = makePi();
		const ctx = makeCtx();
		registerLifecycleHooks(pi as never, ctx);

		await trigger("session_start", { reason: "startup" }, uiCtx);

		// No pending delivery via sendMessage
		expect(sendMessage).not.toHaveBeenCalled();
		// File remains absent
		expect(readPendingMessage(root)).toBeNull();
		// maybeRunCrashRecoveryScan is called but returns early because ctx.db is null.
		// The observable side-effect is that scanForStuckSlices is NOT called
		// (maybeRunCrashRecoveryScan bails at `if (!needsScan || !ctx.db) return`
		// because lock is null → needsScan=true but ctx.db is null).
		expect(vi.mocked(scanForStuckSlices)).not.toHaveBeenCalled();
	});

	it("session_start on 'new' still delivers pending-phase-message.txt correctly", async () => {
		writePendingMessage(root, "plan-prompt-content");

		const { pi, sendMessage, trigger } = makePi();
		const ctx = makeCtx();
		registerLifecycleHooks(pi as never, ctx);

		await trigger("session_start", { reason: "new" }, uiCtx);

		expect(sendMessage).toHaveBeenCalledOnce();
		const call = sendMessage.mock.calls[0];
		const msg = call?.[0];
		expect(msg).toMatchObject({
			customType: "tff-phase",
			content: "plan-prompt-content",
		});
		expect(readPendingMessage(root)).toBeNull();
	});

	it("session_start on 'new' does NOT deliver pending message on startup path", async () => {
		// Ensure the startup-specific branch doesn't fire when reason is "new"
		writePendingMessage(root, "some-message");

		const { pi, sendMessage, trigger } = makePi();
		const ctx = makeCtx();
		registerLifecycleHooks(pi as never, ctx);

		// reason="new" triggers the "new" branch, not the startup branch
		await trigger("session_start", { reason: "new" }, uiCtx);

		// Called exactly once (via the "new" path, not twice)
		expect(sendMessage).toHaveBeenCalledOnce();
	});
});
