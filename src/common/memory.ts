import {
	type MemoryService,
	type MemoryServiceHandle,
	createMemoryService,
} from "@the-forge-flow/hippo-memory-pi";

let handle: MemoryServiceHandle | null = null;

/**
 * Initialize hippo-memory for this project. hippo-memory is a required peer
 * dependency — if `createMemoryService` throws, let the error propagate so
 * session_start fails loudly rather than silently running without memory.
 */
export async function initMemory(cwd: string): Promise<MemoryService> {
	if (!handle) {
		handle = await createMemoryService({ cwd });
	}
	return handle.service;
}

/**
 * Returns the memory service. Null only before `initMemory` has run
 * (i.e., during module load, before session_start fires). After
 * session_start completes, callers can treat this as non-null.
 */
export function getMemory(): MemoryService | null {
	return handle?.service ?? null;
}

export async function shutdownMemory(): Promise<void> {
	if (handle) {
		await handle.release();
		handle = null;
	}
}

export function resetMemoryForTest(): void {
	handle = null;
}
