import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInitialize = vi.fn();
const mockShutdown = vi.fn();
const mockFind = vi.fn();
const mockGrep = vi.fn();

vi.mock("@the-forge-flow/fff-pi", () => ({
	FffService: vi.fn().mockImplementation(() => ({
		initialize: mockInitialize,
		shutdown: mockShutdown,
		find: mockFind,
		grep: mockGrep,
	})),
}));

import {
	FffBridge,
	getFffBridge,
	initFffBridge,
	resetFffBridgeForTest,
	shutdownFffBridge,
} from "../../../src/common/fff-integration.js";

describe("fff-integration", () => {
	beforeEach(() => {
		resetFffBridgeForTest();
		mockInitialize.mockReset().mockResolvedValue(undefined);
		mockShutdown.mockReset().mockResolvedValue(undefined);
		mockFind.mockReset().mockReturnValue({ items: [] });
		mockGrep.mockReset().mockReturnValue({ items: [] });
	});

	it("initFffBridge returns a bridge and caches it", async () => {
		const b1 = await initFffBridge("/tmp/proj");
		const b2 = await initFffBridge("/tmp/proj");
		expect(b1).not.toBeNull();
		expect(b1).toBe(b2);
		expect(mockInitialize).toHaveBeenCalledOnce();
	});

	it("initFffBridge returns null on init failure", async () => {
		mockInitialize.mockRejectedValueOnce(new Error("nope"));
		const b = await initFffBridge("/tmp/proj");
		expect(b).toBeNull();
	});

	it("find returns empty array when not initialized", async () => {
		const bridge = new FffBridge();
		expect(await bridge.find("x")).toEqual([]);
		expect(mockFind).not.toHaveBeenCalled();
	});

	it("find forwards to service and unwraps items after initialize", async () => {
		mockFind.mockReturnValueOnce({ items: [{ path: "a.ts", score: 0.5 }] });
		const bridge = await initFffBridge("/tmp/proj");
		if (!bridge) throw new Error("bridge should be non-null");
		const results = await bridge.find("foo", { maxResults: 5 });
		expect(results).toEqual([{ path: "a.ts", score: 0.5 }]);
		expect(mockFind).toHaveBeenCalledWith("foo", { maxResults: 5 });
	});

	it("grep unwraps items and maps line fields", async () => {
		mockGrep.mockReturnValueOnce({
			items: [{ path: "b.ts", lineNumber: 7, lineContent: "hit" }],
		});
		const bridge = await initFffBridge("/tmp/proj");
		if (!bridge) throw new Error("bridge should be non-null");
		const results = await bridge.grep(["x"], { maxResults: 3 });
		expect(results).toEqual([{ path: "b.ts", line: 7, text: "hit" }]);
		expect(mockGrep).toHaveBeenCalledWith(["x"], { maxResults: 3 });
	});

	it("grep returns empty on service error", async () => {
		mockGrep.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		const bridge = await initFffBridge("/tmp/proj");
		if (!bridge) throw new Error("bridge should be non-null");
		const results = await bridge.grep(["x"]);
		expect(results).toEqual([]);
	});

	it("shutdownFffBridge clears cached instance", async () => {
		await initFffBridge("/tmp/proj");
		expect(getFffBridge()).not.toBeNull();
		await shutdownFffBridge();
		expect(getFffBridge()).toBeNull();
		expect(mockShutdown).toHaveBeenCalledOnce();
	});
});
