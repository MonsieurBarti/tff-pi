import { type Level, compressTextLexical, getActiveLevel } from "@the-forge-flow/ultra-compress-pi";
import type { Settings } from "./settings.js";

let cachedLevel: Level | null = null;

export async function refreshCompressionLevel(projectRoot?: string): Promise<void> {
	try {
		cachedLevel = await getActiveLevel(projectRoot);
	} catch {
		cachedLevel = "off";
	}
}

export function getCachedLevel(): Level | null {
	return cachedLevel;
}

export type CompressScope = "artifacts" | "context_injection" | "phase_prompts";

export function compressIfEnabled(input: string, scope: CompressScope, settings: Settings): string {
	if (!cachedLevel || cachedLevel === "off") return input;
	const applyTo = settings.compress.apply_to;
	if (!applyTo || !applyTo.includes(scope)) return input;
	try {
		const { compressed } = compressTextLexical(input, cachedLevel);
		return compressed;
	} catch {
		return input;
	}
}

export function resetCompressionForTest(): void {
	cachedLevel = null;
}
