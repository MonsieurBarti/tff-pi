// Test stub for @the-forge-flow/hippo-memory-pi.
//
// The real package transitively imports `node:sqlite` (via hippo-memory's
// db.js), which Bun on Linux x64 does not provide. Aliasing the package to
// this stub during tests bypasses the native-module load path entirely.
// Test files that need to exercise real memory behavior can still override
// via vi.mock — vitest's per-file mocks take precedence over the alias.

import { vi } from "vitest";

export interface MemoryService {
	remember: (input: unknown) => Promise<unknown>;
	recall: (input: unknown) => Promise<unknown>;
	forget?: (input: unknown) => Promise<unknown>;
	close?: () => Promise<void>;
}

export interface MemoryServiceHandle {
	service: MemoryService;
	release: () => Promise<void>;
	shared: boolean;
}

export interface CreateMemoryServiceOptions {
	cwd?: string;
}

export const createMemoryService = vi.fn(
	async (_opts?: CreateMemoryServiceOptions): Promise<MemoryServiceHandle> => ({
		service: {
			remember: vi.fn().mockResolvedValue(undefined),
			recall: vi.fn().mockResolvedValue([]),
		},
		release: vi.fn().mockResolvedValue(undefined),
		shared: false,
	}),
);
