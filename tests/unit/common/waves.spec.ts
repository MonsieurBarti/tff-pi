import { describe, expect, it } from "vitest";
import { computeWaves } from "../../../src/common/waves.js";

describe("computeWaves", () => {
	it("assigns wave 1 to tasks with no dependencies", () => {
		const tasks = [
			{ id: "a", number: 1 },
			{ id: "b", number: 2 },
		];
		const deps: { fromTaskId: string; toTaskId: string }[] = [];
		const waves = computeWaves(tasks, deps);
		expect(waves.get("a")).toBe(1);
		expect(waves.get("b")).toBe(1);
	});

	it("assigns sequential waves based on dependency chain", () => {
		const tasks = [
			{ id: "a", number: 1 },
			{ id: "b", number: 2 },
			{ id: "c", number: 3 },
		];
		// b depends on a, c depends on b
		const deps = [
			{ fromTaskId: "b", toTaskId: "a" },
			{ fromTaskId: "c", toTaskId: "b" },
		];
		const waves = computeWaves(tasks, deps);
		expect(waves.get("a")).toBe(1);
		expect(waves.get("b")).toBe(2);
		expect(waves.get("c")).toBe(3);
	});

	it("groups independent tasks into the same wave", () => {
		const tasks = [
			{ id: "a", number: 1 },
			{ id: "b", number: 2 },
			{ id: "c", number: 3 },
		];
		const deps = [
			{ fromTaskId: "b", toTaskId: "a" },
			{ fromTaskId: "c", toTaskId: "a" },
		];
		const waves = computeWaves(tasks, deps);
		expect(waves.get("a")).toBe(1);
		expect(waves.get("b")).toBe(2);
		expect(waves.get("c")).toBe(2);
	});

	it("handles diamond dependencies", () => {
		const tasks = [
			{ id: "a", number: 1 },
			{ id: "b", number: 2 },
			{ id: "c", number: 3 },
			{ id: "d", number: 4 },
		];
		const deps = [
			{ fromTaskId: "b", toTaskId: "a" },
			{ fromTaskId: "c", toTaskId: "a" },
			{ fromTaskId: "d", toTaskId: "b" },
			{ fromTaskId: "d", toTaskId: "c" },
		];
		const waves = computeWaves(tasks, deps);
		expect(waves.get("a")).toBe(1);
		expect(waves.get("b")).toBe(2);
		expect(waves.get("c")).toBe(2);
		expect(waves.get("d")).toBe(3);
	});

	it("throws on cyclic dependencies", () => {
		const tasks = [
			{ id: "a", number: 1 },
			{ id: "b", number: 2 },
		];
		const deps = [
			{ fromTaskId: "a", toTaskId: "b" },
			{ fromTaskId: "b", toTaskId: "a" },
		];
		expect(() => computeWaves(tasks, deps)).toThrow(/cycle/i);
	});

	it("returns empty map for empty input", () => {
		const waves = computeWaves([], []);
		expect(waves.size).toBe(0);
	});
});
