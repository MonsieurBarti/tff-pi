//
// Consumer contract: every reader analyzing PRODUCTION routing decisions
// MUST filter `dry_run === false`. Dry-run rows are session-start telemetry.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ModelTierSchema } from "./agent-capability.js";
import { errnoCode } from "./fs-helpers.js";
import { SignalsSchema } from "./signals.js";

const PhaseSchema = Type.Union([
	Type.Literal("execute"),
	Type.Literal("verify"),
	Type.Literal("review"),
]);

const RouteRowSchema = Type.Object({
	kind: Type.Literal("route"),
	timestamp: Type.String(),
	phase: PhaseSchema,
	slice_id: Type.String(),
	agent_id: Type.String(),
	signals: SignalsSchema,
	confidence: Type.Number(),
	fallback_used: Type.Boolean(),
	decision_id: Type.String(),
	dry_run: Type.Boolean(),
});
const TierRowSchema = Type.Object({
	kind: Type.Literal("tier"),
	timestamp: Type.String(),
	phase: PhaseSchema,
	slice_id: Type.String(),
	agent_id: Type.String(),
	signals: SignalsSchema,
	tier: Type.Union([ModelTierSchema, Type.Null()]),
	policy_tier: Type.Union([ModelTierSchema, Type.Null()]),
	min_tier_applied: Type.Boolean(),
	decision_id: Type.String(),
	dry_run: Type.Boolean(),
});
const AuditRowSchema = Type.Union([RouteRowSchema, TierRowSchema]);

export type RouteRow = Static<typeof RouteRowSchema>;
export type TierRow = Static<typeof TierRowSchema>;
export type AuditRow = Static<typeof AuditRowSchema>;

const auditPath = (root: string) => join(root, ".pi", ".tff", "routing.jsonl");

export async function appendAuditRows(root: string, rows: AuditRow[]): Promise<void> {
	if (rows.length === 0) return;
	const path = auditPath(root);
	await mkdir(dirname(path), { recursive: true });
	const blob = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await appendFile(path, blob, "utf8");
}

export async function readAuditRows(root: string): Promise<AuditRow[]> {
	let text: string;
	try {
		text = await readFile(auditPath(root), "utf8");
	} catch (e) {
		if (errnoCode(e) === "ENOENT") return [];
		throw e;
	}
	const out: AuditRow[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		const parsed: unknown = JSON.parse(line);
		if (!Value.Check(AuditRowSchema, parsed)) {
			throw new Error(`routing.jsonl: malformed row — ${line.slice(0, 120)}`);
		}
		out.push(parsed);
	}
	return out;
}
