export { decide, type AgentDecision, type DecideOptions } from "./decide.js";
export type { TierPolicy } from "./tier-resolver.js";
export {
	decideAndAudit,
	type DecideAndAuditInput,
	type DecideAndAuditDeps,
} from "./decide-and-audit.js";
export {
	loadRoutingConfig,
	RoutingConfigParseError,
	type RoutingConfig,
} from "./routing-config.js";
export { loadPool, DEFAULT_POOL_IDS, type Phase, type WorkflowPool } from "./pool.js";
export { readAgentCapability, AgentLoadError } from "./agent-loader.js";
export {
	appendAuditRows,
	readAuditRows,
	type AuditRow,
	type RouteRow,
	type TierRow,
} from "./routing-audit-log.js";
