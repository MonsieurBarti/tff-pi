import type { AgentCapability } from "./agent-capability.js";
import type { WorkflowPool } from "./pool.js";
import type { Signals } from "./signals.js";

export interface RankedAgent {
	agent: AgentCapability;
	match_ratio: number;
}

export function signalsToTagSet(signals: Signals): Set<string> {
	const tags = new Set<string>();
	tags.add(`${signals.complexity}_complexity`);
	tags.add(`${signals.risk.level}_risk`);
	for (const t of signals.risk.tags) tags.add(t);
	return tags;
}

export function scoreAgents(pool: WorkflowPool, signals: Signals): RankedAgent[] {
	const signalTags = signalsToTagSet(signals);
	const denom = Math.max(signalTags.size, 1);
	const ranked: RankedAgent[] = pool.agents.map((agent) => {
		let matches = 0;
		for (const h of agent.handles) if (signalTags.has(h)) matches++;
		return { agent, match_ratio: matches / denom };
	});
	ranked.sort((a, b) => {
		if (b.match_ratio !== a.match_ratio) return b.match_ratio - a.match_ratio;
		return b.agent.priority - a.agent.priority;
	});
	return ranked;
}
