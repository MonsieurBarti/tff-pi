import { FffService } from "@the-forge-flow/fff-pi";

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
	private service: FffService;
	private ready = false;

	constructor() {
		this.service = new FffService();
	}

	async initialize(cwd: string): Promise<void> {
		if (this.ready) return;
		await this.service.initialize(cwd);
		this.ready = true;
	}

	async shutdown(): Promise<void> {
		if (!this.ready) return;
		await this.service.shutdown();
		this.ready = false;
	}

	async find(query: string, opts?: { maxResults?: number }): Promise<FffFindResult[]> {
		if (!this.ready) return [];
		try {
			const result = await this.service.find(query, opts);
			const items = (result as { items?: Array<{ path: string; score?: number }> }).items ?? [];
			return items.map((item) => {
				const out: FffFindResult = { path: item.path };
				if (item.score !== undefined) out.score = item.score;
				return out;
			});
		} catch {
			return [];
		}
	}

	async grep(patterns: string[], opts?: { maxResults?: number }): Promise<FffGrepResult[]> {
		if (!this.ready) return [];
		try {
			const result = await this.service.grep(patterns, opts);
			const items =
				(result as { items?: Array<{ path: string; lineNumber?: number; lineContent?: string }> })
					.items ?? [];
			return items.map((item) => {
				const out: FffGrepResult = { path: item.path };
				if (item.lineNumber !== undefined) out.line = item.lineNumber;
				if (item.lineContent !== undefined) out.text = item.lineContent;
				return out;
			});
		} catch {
			return [];
		}
	}
}

let cached: FffBridge | null = null;

export async function initFffBridge(cwd: string): Promise<FffBridge | null> {
	try {
		if (!cached) {
			cached = new FffBridge();
			await cached.initialize(cwd);
		}
		return cached;
	} catch {
		cached = null;
		return null;
	}
}

export function getFffBridge(): FffBridge | null {
	return cached;
}

export async function shutdownFffBridge(): Promise<void> {
	if (cached) {
		try {
			await cached.shutdown();
		} catch {
			// best-effort
		}
		cached = null;
	}
}

export function resetFffBridgeForTest(): void {
	cached = null;
}
