import {
	type MemoryService,
	type MemoryServiceHandle,
	createMemoryService,
} from "@the-forge-flow/hippo-memory-pi";

let handle: MemoryServiceHandle | null = null;

export async function initMemory(cwd: string): Promise<MemoryService | null> {
	try {
		if (!handle) {
			handle = await createMemoryService({ cwd });
		}
		return handle.service;
	} catch {
		return null;
	}
}

export function getMemory(): MemoryService | null {
	return handle?.service ?? null;
}

export async function shutdownMemory(): Promise<void> {
	if (handle) {
		try {
			await handle.release();
		} catch {
			// best-effort
		}
		handle = null;
	}
}

export function resetMemoryForTest(): void {
	handle = null;
}
