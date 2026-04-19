import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSessionId,
	logError,
	logException,
	logWarning,
	readAuditLog,
	setLogBasePath,
	setStderrLoggingEnabled,
} from "../../../src/common/logger.js";

const { auditWriteFailureMock } = vi.hoisted(() => ({
	auditWriteFailureMock: { impl: null as null | (() => void) },
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		openSync: ((path: string, ...rest: unknown[]) => {
			if (auditWriteFailureMock.impl !== null && String(path).endsWith("audit-log.jsonl")) {
				auditWriteFailureMock.impl();
			}
			// biome-ignore lint/suspicious/noExplicitAny: passthrough to real openSync with variadic signature
			return (actual.openSync as any)(path, ...rest);
		}) as typeof actual.openSync,
	};
});

describe("logger", () => {
	let root: string;
	let stderrSpy: MockInstance;
	let startTs: number;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-logger-"));
		setLogBasePath(root);
		setStderrLoggingEnabled(true);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		startTs = Date.now();
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		rmSync(root, { recursive: true, force: true });
		auditWriteFailureMock.impl = null;
	});

	function readAudit(): Array<Record<string, unknown>> {
		const path = join(root, ".pi", ".tff", "audit-log.jsonl");
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	}

	function stderrLines(): Array<Record<string, unknown>> {
		return stderrSpy.mock.calls.map(
			(call) => JSON.parse(String(call[0])) as Record<string, unknown>,
		);
	}

	it("logError writes one JSON line to audit-log and one to stderr", () => {
		logError("event-logger", "handler_failed", { tool: "tff_transition" });
		expect(readAudit()).toHaveLength(1);
		expect(stderrLines()).toHaveLength(1);
		const line = readAudit()[0] as {
			level: string;
			ts: string;
			component: string;
			message: string;
			ctx: { tool?: string };
			session_id: string;
		};
		expect(line.level).toBe("error");
		expect(line.component).toBe("event-logger");
		expect(line.message).toBe("handler_failed");
		expect(line.ctx.tool).toBe("tff_transition");
		expect(typeof line.ts).toBe("string");
		expect(new Date(line.ts).getTime()).toBeGreaterThanOrEqual(startTs);
		expect(typeof line.session_id).toBe("string");
		expect(line.session_id.length).toBeGreaterThan(0);
	});

	it("logWarning writes only to stderr, no audit-log file", () => {
		logWarning("state-branch", "push_failed", { step: "worktree-add" });
		expect(readAudit()).toHaveLength(0);
		expect(existsSync(join(root, ".pi", ".tff", "audit-log.jsonl"))).toBe(false);
		const lines = stderrLines();
		expect(lines).toHaveLength(1);
		expect((lines[0] as { level: string }).level).toBe("warn");
	});

	it("logException captures stack and uses name + message", () => {
		const err = new Error("boom");
		err.name = "CustomError";
		logException("db", err, { fn: "openDatabase" });
		const line = readAudit()[0] as {
			message: string;
			ctx: { stack?: string; fn?: string };
		};
		expect(line.message).toBe("CustomError: boom");
		expect(line.ctx.stack).toBeDefined();
		expect(typeof line.ctx.stack).toBe("string");
		expect(line.ctx.fn).toBe("openDatabase");
	});

	it("logException handles non-Error values defensively", () => {
		logException("commit", "raw-string");
		logException("commit", 42);
		logException("commit", { shape: "object" });
		const lines = readAudit();
		expect(lines).toHaveLength(3);
		expect((lines[0] as { message: string }).message).toBe("raw-string");
		expect((lines[1] as { message: string }).message).toBe("42");
		expect((lines[2] as { message: string }).message).toBe("[object Object]");
		expect((lines[0] as { ctx: Record<string, unknown> }).ctx.stack).toBeUndefined();
		expect((lines[1] as { ctx: Record<string, unknown> }).ctx.stack).toBeUndefined();
		expect((lines[2] as { ctx: Record<string, unknown> }).ctx.stack).toBeUndefined();
	});

	it("logException stack auto-capture cannot be overridden by caller ctx", () => {
		const err = new Error("real");
		logException("db", err, { stack: "fake-stack-from-caller" });
		const lineA = readAudit()[0] as { ctx: { stack?: string } };
		expect(lineA.ctx.stack).toBe(err.stack);
		expect(lineA.ctx.stack).not.toBe("fake-stack-from-caller");

		// And for non-Error values, caller-supplied stack must also be dropped.
		logException("db", "just-a-string", { stack: "fake-stack-2" });
		const lineB = readAudit()[1] as { ctx: { stack?: string } };
		expect(lineB.ctx.stack).toBeUndefined();
	});

	it("setLogBasePath twice redirects subsequent appends", () => {
		const root2 = mkdtempSync(join(tmpdir(), "tff-logger-2-"));
		try {
			logError("logger", "first");
			setLogBasePath(root2);
			logError("logger", "second");
			expect(readAudit()).toHaveLength(1);
			const secondPath = join(root2, ".pi", ".tff", "audit-log.jsonl");
			expect(existsSync(secondPath)).toBe(true);
			const second = readFileSync(secondPath, "utf-8").trim().split("\n");
			expect(second).toHaveLength(1);
			expect((JSON.parse(second[0] as string) as { message: string }).message).toBe("second");
		} finally {
			rmSync(root2, { recursive: true, force: true });
		}
	});

	it("logError still writes stderr even if audit-log parent is removed mid-run", () => {
		rmSync(root, { recursive: true, force: true });
		logError("logger", "still-works");
		expect(stderrLines().length).toBeGreaterThanOrEqual(1);
	});

	it("setStderrLoggingEnabled(false) silences stderr but keeps audit", () => {
		setStderrLoggingEnabled(false);
		logError("logger", "silent-stderr");
		logWarning("logger", "silent-warn");
		expect(stderrLines()).toHaveLength(0);
		expect(readAudit()).toHaveLength(1);
	});

	it("getSessionId is stable across calls within a process", () => {
		const a = getSessionId();
		const b = getSessionId();
		expect(a).toBe(b);
		expect(a.length).toBeGreaterThan(0);
		logError("logger", "line-1");
		logError("logger", "line-2");
		const lines = readAudit();
		expect((lines[0] as { session_id: string }).session_id).toBe(a);
		expect((lines[1] as { session_id: string }).session_id).toBe(a);
	});

	it("unknown context keys are dropped silently", () => {
		logError("logger", "sanitize", {
			tool: "ok",
			rogue: "dropped",
			another: 123,
		} as unknown as Parameters<typeof logError>[2]);
		const line = readAudit()[0] as { ctx: Record<string, unknown> };
		expect(line.ctx.tool).toBe("ok");
		expect(line.ctx.rogue).toBeUndefined();
		expect(line.ctx.another).toBeUndefined();
	});

	it("ctx.error is coerced to string when non-string", () => {
		const e = new Error("nested");
		logError("logger", "coerce", {
			error: e as unknown as string,
		});
		const line = readAudit()[0] as { ctx: { error?: string } };
		expect(typeof line.ctx.error).toBe("string");
		expect(line.ctx.error).toContain("nested");
	});

	it("readAuditLog returns parsed objects", () => {
		logError("logger", "one");
		logError("logger", "two");
		const parsed = readAuditLog(root);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]?.message).toBe("one");
		expect(parsed[1]?.message).toBe("two");
	});

	it("audit-append failure surfaces one stderr line and does not loop", () => {
		auditWriteFailureMock.impl = () => {
			throw new Error("read-only-fs");
		};
		logError("logger", "will-fail-to-append");
		const lines = stderrLines();
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const failLine = lines.find(
			(l) => (l as { message: string }).message === "audit-append-failed",
		);
		expect(failLine).toBeDefined();
		expect((failLine as { component: string }).component).toBe("logger");
	});
});
