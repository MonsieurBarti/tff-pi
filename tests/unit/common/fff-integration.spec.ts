import { describe, expect, it, vi } from "vitest";
import { FffBridge, discoverFffService } from "../../../src/common/fff-integration.js";

function makePi(
	toolNames: string[],
	execResult?: { code: number; stdout: string; stderr: string },
) {
	return {
		getAllTools: vi.fn(() => toolNames.map((name) => ({ name }))),
		exec: vi
			.fn()
			.mockResolvedValue(
				execResult ?? { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" },
			),
	};
}

describe("discoverFffService", () => {
	it("returns null when fff tools not registered", () => {
		const pi = makePi(["some-other-tool"]);
		const result = discoverFffService(pi as never);
		expect(result).toBeNull();
	});

	it("returns FffBridge when tff-fff_find is registered", () => {
		const pi = makePi(["tff-fff_find", "tff-fff_grep"]);
		const result = discoverFffService(pi as never);
		expect(result).toBeInstanceOf(FffBridge);
	});
});

describe("FffBridge", () => {
	describe("find", () => {
		it("invokes exec with tff-fff_find and parses results", async () => {
			const items = [{ path: "src/foo.ts", score: 0.9 }];
			const pi = makePi(["tff-fff_find"], {
				code: 0,
				stdout: JSON.stringify({ items }),
				stderr: "",
			});
			const bridge = new FffBridge(pi as never);
			const results = await bridge.find("foo");
			expect(pi.exec).toHaveBeenCalledOnce();
			const firstCall = pi.exec.mock.calls[0] as [string, string[]];
			const [cmd, args] = firstCall;
			expect(cmd).toBe("pi");
			expect(args).toContain("tff-fff_find");
			expect(args).toContain("foo");
			expect(results).toEqual(items);
		});

		it("returns empty array on exec failure (non-zero code)", async () => {
			const pi = makePi(["tff-fff_find"], { code: 1, stdout: "", stderr: "error" });
			const bridge = new FffBridge(pi as never);
			const results = await bridge.find("foo");
			expect(results).toEqual([]);
		});

		it("returns empty array when exec throws", async () => {
			const pi = {
				getAllTools: vi.fn(() => [{ name: "tff-fff_find" }]),
				exec: vi.fn().mockRejectedValue(new Error("exec failed")),
			};
			const bridge = new FffBridge(pi as never);
			const results = await bridge.find("foo");
			expect(results).toEqual([]);
		});
	});

	describe("grep", () => {
		it("invokes exec with tff-fff_grep and parses results", async () => {
			const items = [{ path: "src/bar.ts", line: 42, text: "match text" }];
			const pi = makePi(["tff-fff_grep"], {
				code: 0,
				stdout: JSON.stringify({ items }),
				stderr: "",
			});
			const bridge = new FffBridge(pi as never);
			const results = await bridge.grep(["pattern1", "pattern2"]);
			expect(pi.exec).toHaveBeenCalledOnce();
			const [grepCmd, grepArgs] = pi.exec.mock.calls[0] as [string, string[]];
			expect(grepCmd).toBe("pi");
			expect(grepArgs).toContain("tff-fff_grep");
			expect(grepArgs).toContain("pattern1");
			expect(results).toEqual(items);
		});

		it("returns empty array on exec failure (non-zero code)", async () => {
			const pi = makePi(["tff-fff_grep"], { code: 1, stdout: "", stderr: "error" });
			const bridge = new FffBridge(pi as never);
			const results = await bridge.grep(["pattern"]);
			expect(results).toEqual([]);
		});

		it("returns empty array when exec throws", async () => {
			const pi = {
				getAllTools: vi.fn(() => [{ name: "tff-fff_grep" }]),
				exec: vi.fn().mockRejectedValue(new Error("exec failed")),
			};
			const bridge = new FffBridge(pi as never);
			const results = await bridge.grep(["pattern"]);
			expect(results).toEqual([]);
		});
	});
});
