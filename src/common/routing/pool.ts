import type { AgentCapability } from "./agent-capability.js";

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

// loadPool intentionally lives below; T08 fills it in.
