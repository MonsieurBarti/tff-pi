import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface FffFindResult {
	path: string;
	score?: number;
}

export interface FffGrepResult {
	path: string;
	line?: number;
	text?: string;
}

export class FffBridge {
	constructor(private pi: ExtensionAPI) {}

	async find(query: string, maxResults = 10): Promise<FffFindResult[]> {
		try {
			const result = await this.pi.exec("pi", [
				"tff-fff_find",
				query,
				"--max-results",
				String(maxResults),
			]);
			if (result.code !== 0) return [];
			const parsed = JSON.parse(result.stdout) as { items: FffFindResult[] };
			return parsed.items ?? [];
		} catch {
			return [];
		}
	}

	async grep(patterns: string[], maxResults = 10): Promise<FffGrepResult[]> {
		try {
			const result = await this.pi.exec("pi", [
				"tff-fff_grep",
				...patterns,
				"--max-results",
				String(maxResults),
			]);
			if (result.code !== 0) return [];
			const parsed = JSON.parse(result.stdout) as { items: FffGrepResult[] };
			return parsed.items ?? [];
		} catch {
			return [];
		}
	}
}

export function discoverFffService(pi: ExtensionAPI): FffBridge | null {
	const tools = pi.getAllTools();
	const hasFff = tools.some((t: { name: string }) => t.name === "tff-fff_find");
	if (!hasFff) return null;
	return new FffBridge(pi);
}
