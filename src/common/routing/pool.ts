import type { AgentCapability } from "./agent-capability.js";
import { readAgentCapability } from "./agent-loader.js";

export type Phase = "execute" | "verify" | "review";

export interface WorkflowPool {
	phase: Phase;
	agents: AgentCapability[];
}

export const DEFAULT_POOL_IDS: Record<Phase, string[]> = {
	execute: ["tff-executor"],
	verify: ["tff-verifier"],
	review: ["tff-code-reviewer"],
};

export interface LoadPoolConfig {
	pools: Partial<Record<Phase, string[]>>;
}

export async function loadPool(
	root: string,
	phase: Phase,
	config: LoadPoolConfig,
): Promise<WorkflowPool> {
	const ids = config.pools[phase] ?? DEFAULT_POOL_IDS[phase];
	const agents = await Promise.all(ids.map((id) => readAgentCapability(root, id)));
	return { phase, agents };
}
