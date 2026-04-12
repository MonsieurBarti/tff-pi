import { vi } from "vitest";

// Global mocks for sibling PI extensions whose published dist has broken
// directory imports (Node ESM rejects `from "./commands"` without `/index.js`).
// Tests that transitively load these modules would otherwise fail at import.
// Individual tests can still override with their own vi.mock calls.
//
// Tracking:
// - ultra-compress-pi fixed in 0.1.3 — mock no longer needed
// - gh-pi, fff-pi, hippo-memory-pi: ESM fix pending

vi.mock("@the-forge-flow/gh-pi", () => ({
	createGHClient: vi.fn(() => ({})),
	createPRTools: vi.fn(() => ({
		view: vi.fn(),
		create: vi.fn(),
		checks: vi.fn(),
		merge: vi.fn(),
	})),
}));

vi.mock("@the-forge-flow/fff-pi", () => ({
	FffService: vi.fn().mockImplementation(() => ({
		initialize: vi.fn().mockResolvedValue(undefined),
		shutdown: vi.fn().mockResolvedValue(undefined),
		find: vi.fn().mockResolvedValue([]),
		grep: vi.fn().mockResolvedValue([]),
	})),
}));

vi.mock("@the-forge-flow/hippo-memory-pi", () => ({
	createMemoryService: vi.fn().mockResolvedValue({
		service: {
			remember: vi.fn().mockResolvedValue({ id: "x" }),
			recall: vi.fn().mockResolvedValue({ results: [] }),
		},
		release: vi.fn().mockResolvedValue(undefined),
		shared: false,
	}),
}));
