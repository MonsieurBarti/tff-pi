import { randomUUID } from "node:crypto";
import { type AgentDecision, decide } from "./decide.js";
import { type Phase, loadPool } from "./pool.js";
import { type AuditRow, appendAuditRows } from "./routing-audit-log.js";
import { type RoutingConfig, loadRoutingConfig } from "./routing-config.js";
import type { ExtractInput, SignalExtractor } from "./signal-extractor.js";
import { writeSignals } from "./signal-store.js";
import type { Signals } from "./signals.js";

export interface DecideAndAuditInput {
	slice_id: string;
	milestone_number: number;
	slice_number: number;
	phase: Phase;
	extract_input: ExtractInput;
	dry_run?: boolean;
}

export interface DecideAndAuditDeps {
	root: string;
	extractor: SignalExtractor;
	now?: () => Date;
	uuid?: () => string;
}

export async function decideAndAudit(
	input: DecideAndAuditInput,
	deps: DecideAndAuditDeps,
): Promise<{ signals: Signals; decisions: AgentDecision[]; config: RoutingConfig }> {
	const now = deps.now ?? (() => new Date());
	const uuid = deps.uuid ?? randomUUID;
	const dry_run = input.dry_run ?? false;

	const config = await loadRoutingConfig(deps.root);
	const signals = await deps.extractor.extract(input.extract_input);
	await writeSignals(deps.root, input.milestone_number, input.slice_number, signals);

	const pool = await loadPool(deps.root, input.phase, config);
	const decisions = decide(
		signals,
		pool,
		config.tier_policy === undefined
			? { confidence_threshold: config.confidence_threshold, uuid }
			: { confidence_threshold: config.confidence_threshold, policy: config.tier_policy, uuid },
	);

	const ts = now().toISOString();
	const rows: AuditRow[] = [];
	for (const d of decisions) {
		rows.push({
			kind: "route",
			timestamp: ts,
			phase: input.phase,
			slice_id: input.slice_id,
			agent_id: d.agent_id,
			signals,
			confidence: d.confidence,
			fallback_used: d.fallback_used,
			decision_id: d.route_decision_id,
			dry_run,
		});
		rows.push({
			kind: "tier",
			timestamp: ts,
			phase: input.phase,
			slice_id: input.slice_id,
			agent_id: d.agent_id,
			signals,
			tier: d.tier,
			policy_tier: d.policy_tier,
			min_tier_applied: d.min_tier_applied,
			decision_id: d.tier_decision_id,
			dry_run,
		});
	}
	await appendAuditRows(deps.root, rows);
	return { signals, decisions, config };
}
