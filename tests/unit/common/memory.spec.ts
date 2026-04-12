import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockRelease } = vi.hoisted(() => ({
	mockCreate: vi.fn(),
	mockRelease: vi.fn(),
}));

vi.mock("@the-forge-flow/hippo-memory-pi", () => ({
	createMemoryService: mockCreate,
}));

import {
	getMemory,
	initMemory,
	resetMemoryForTest,
	shutdownMemory,
} from "../../../src/common/memory.js";

describe("memory singleton", () => {
	beforeEach(async () => {
		await shutdownMemory();
		resetMemoryForTest();
		mockCreate.mockReset();
		mockRelease.mockReset().mockResolvedValue(undefined);
	});

	it("initMemory returns service on success", async () => {
		const fakeService = { remember: vi.fn(), recall: vi.fn() };
		mockCreate.mockResolvedValueOnce({
			service: fakeService,
			release: mockRelease,
			shared: false,
		});
		const m = await initMemory("/tmp/proj");
		expect(m).toBe(fakeService);
		expect(getMemory()).toBe(fakeService);
	});

	it("initMemory caches across calls", async () => {
		const fakeService = { remember: vi.fn() };
		mockCreate.mockResolvedValueOnce({
			service: fakeService,
			release: mockRelease,
			shared: false,
		});
		await initMemory("/tmp/proj");
		await initMemory("/tmp/proj");
		expect(mockCreate).toHaveBeenCalledOnce();
	});

	it("returns null when createMemoryService throws", async () => {
		mockCreate.mockRejectedValueOnce(new Error("no db"));
		const m = await initMemory("/tmp/proj");
		expect(m).toBeNull();
		expect(getMemory()).toBeNull();
	});

	it("shutdownMemory releases the handle and clears cache", async () => {
		const fakeService = { remember: vi.fn() };
		mockCreate.mockResolvedValueOnce({
			service: fakeService,
			release: mockRelease,
			shared: false,
		});
		await initMemory("/tmp/proj");
		await shutdownMemory();
		expect(getMemory()).toBeNull();
		expect(mockRelease).toHaveBeenCalledOnce();
	});

	it("shutdownMemory swallows release errors", async () => {
		const fakeService = { remember: vi.fn() };
		mockRelease.mockRejectedValueOnce(new Error("release fail"));
		mockCreate.mockResolvedValueOnce({
			service: fakeService,
			release: mockRelease,
			shared: false,
		});
		await initMemory("/tmp/proj");
		await expect(shutdownMemory()).resolves.toBeUndefined();
		expect(getMemory()).toBeNull();
	});

	it("works correctly with shared handle (shared: true, release is no-op)", async () => {
		const fakeService = { remember: vi.fn() };
		// Shared handles' release is a no-op but must still be called
		mockRelease.mockResolvedValueOnce(undefined);
		mockCreate.mockResolvedValueOnce({
			service: fakeService,
			release: mockRelease,
			shared: true,
		});
		await initMemory("/tmp/proj");
		expect(getMemory()).toBe(fakeService);
		await shutdownMemory();
		expect(getMemory()).toBeNull();
		expect(mockRelease).toHaveBeenCalledOnce();
	});
});
