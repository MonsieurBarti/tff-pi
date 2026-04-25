import { readFile } from "node:fs/promises";
import type { ComplexityLevel, RiskLevel, Signals } from "./signals.js";

const RISK_KEYWORDS: Record<string, string> = {
	auth: "auth",
	authentication: "auth",
	migration: "migrations",
	migrations: "migrations",
	breaking: "breaking",
	security: "security",
	pii: "pii",
	secret: "secret",
	credential: "secret",
};

const complexityFromFileCount = (n: number): ComplexityLevel => {
	if (n >= 15) return "high";
	if (n >= 5) return "medium";
	return "low";
};

export interface ExtractInput {
	slice_id: string;
	spec_path?: string;
	plan_path?: string;
	affected_files: string[];
	description: string;
}

export interface SignalExtractor {
	extract(input: ExtractInput): Promise<Signals>;
}

export class FilesystemSignalExtractor implements SignalExtractor {
	async extract(input: ExtractInput): Promise<Signals> {
		const specText = input.spec_path ? await readFile(input.spec_path, "utf8").catch(() => "") : "";
		const haystack = `${specText}\n${input.description}`.toLowerCase();

		const tags = new Set<string>();
		for (const [kw, tag] of Object.entries(RISK_KEYWORDS)) {
			if (haystack.includes(kw)) tags.add(tag);
		}

		const complexity = complexityFromFileCount(input.affected_files.length);
		const riskLevel: RiskLevel = tags.size >= 2 ? "high" : tags.size === 1 ? "medium" : "low";

		return {
			complexity,
			risk: { level: riskLevel, tags: [...tags].sort() },
		};
	}
}
