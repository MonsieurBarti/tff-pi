import { vi } from "vitest";

// Global mock for ultra-compress-pi — the published dist has broken directory
// imports (no extensions) that Node's ESM loader cannot resolve. Tests that
// transitively load src/common/compress.js would otherwise fail at import time.
// Individual tests can still override these mocks with their own vi.mock calls.
vi.mock("@the-forge-flow/ultra-compress-pi", () => ({
	getActiveLevel: vi.fn().mockResolvedValue("off"),
	compressTextLexical: vi.fn((input: string) => ({ compressed: input })),
}));
