// Isolated module for test #3: spy on fsyncSync via vi.mock at the file level.
// Must live in its own file so the mock does not affect other event-log tests.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const fsyncCalls: number[] = [];

vi.mock("node:fs", async () => {
	const real = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...real,
		fsyncSync: (fd: number) => {
			fsyncCalls.push(fd);
			real.fsyncSync(fd);
		},
	};
});

describe("appendCommand — fsync guarantee", () => {
	test("calls fsyncSync on the underlying fd before returning", async () => {
		// Import after mock is established
		const { appendCommand } = await import("../../../src/common/event-log.js");
		const root = mkdtempSync(join(tmpdir(), "tff-fsync-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
		fsyncCalls.length = 0;
		appendCommand(root, "write-spec", { sliceId: "s1" });
		expect(fsyncCalls.length).toBeGreaterThanOrEqual(1);
	});
});
