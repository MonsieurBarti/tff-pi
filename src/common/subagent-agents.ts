import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TFF_AGENT_NAMES = [
	"tff-executor",
	"tff-fixer",
	"tff-verifier",
	"tff-code-reviewer",
	"tff-security-auditor",
] as const;

export type TffAgentName = (typeof TFF_AGENT_NAMES)[number];

export function ensureProjectAgents(root: string, resourcesDir: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	for (const name of TFF_AGENT_NAMES) {
		const src = join(resourcesDir, "agents", `${name}.md`);
		const dst = join(dir, `${name}.md`);
		writeFileSync(dst, readFileSync(src));
	}
}
