import type Database from "better-sqlite3";
import type { ToolCallEvent } from "./events.js";

export interface ParsedClaim {
	raw: string;
	command: string;
	expectedExit?: number;
}

export type Verdict = "match" | "mismatch" | "unverifiable";

export interface AuditEvidence {
	toolCallId: string;
	actualCommand: string;
	actualExit: 0 | 1;
	timestamp: string;
}

export interface AuditFinding {
	claim: ParsedClaim;
	verdict: Verdict;
	evidence?: AuditEvidence;
	reason: string;
}

export interface AuditReport {
	findings: AuditFinding[];
	summary: { match: number; mismatch: number; unverifiable: number };
	hasMismatches: boolean;
}

export function parseVerificationClaims(md: string): ParsedClaim[] {
	if (!md) return [];
	const claims: ParsedClaim[] = [];
	const seen = new Set<string>();

	// Pattern 3 must run first so AC checklist lines don't also get
	// picked up by Pattern 1's inline-verdict scan (AC lines happen to
	// contain "pass"/"fail" keywords frequently).
	parseAcChecklistLines(md, claims, seen);
	parseFencedBlocks(md, claims, seen);
	parseInlineVerdicts(md, claims, seen);

	return claims;
}

function pushIfNew(claims: ParsedClaim[], seen: Set<string>, claim: ParsedClaim): void {
	const key = `${claim.command}|${claim.expectedExit ?? "?"}`;
	if (seen.has(key)) return;
	seen.add(key);
	claims.push(claim);
}

function parseAcChecklistLines(md: string, claims: ParsedClaim[], seen: Set<string>): void {
	// Match: `- [x] AC-3: ... \`cmd\`` or `- [ ] AC-4: ... \`cmd\``
	const re = /^\s*-\s*\[([x ])\]\s*AC-\d+[^\n`]*`([^`\n]{3,200})`/gim;
	let match: RegExpExecArray | null = re.exec(md);
	while (match) {
		const box = match[1];
		const command = match[2]?.trim() ?? "";
		if (command.length >= 3) {
			pushIfNew(claims, seen, {
				raw: match[0],
				command,
				expectedExit: box === "x" ? 0 : 1,
			});
		}
		match = re.exec(md);
	}
}

function parseFencedBlocks(md: string, claims: ParsedClaim[], seen: Set<string>): void {
	const blockRe = /```[^\n]*\n([\s\S]*?)```/g;
	let blockMatch: RegExpExecArray | null = blockRe.exec(md);
	while (blockMatch) {
		const body = blockMatch[1] ?? "";
		const lines = body.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const cmdMatch = /^\$ (.+)$/.exec(line);
			if (!cmdMatch) continue;
			const command = (cmdMatch[1] ?? "").trim();
			if (command.length < 3) continue;

			const outputLines: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const l = lines[j] ?? "";
				// Stop at the next shell-prompt line; blank lines WITHIN the output are
				// normal (bun test, jest, etc. emit blank lines before the failure
				// summary). Breaking on blank lines would mis-classify real failures.
				if (l.startsWith("$ ")) break;
				outputLines.push(l);
			}
			const output = outputLines.join("\n").toLowerCase();
			const failed = /\berror\b|\bfailed?\b|\bexit\s+[1-9]/.test(output);
			pushIfNew(claims, seen, {
				raw: `$ ${command}`,
				command,
				expectedExit: failed ? 1 : 0,
			});
		}
		blockMatch = blockRe.exec(md);
	}
}

function parseInlineVerdicts(md: string, claims: ParsedClaim[], seen: Set<string>): void {
	const re =
		/`([^`\n]{3,200})`[^\n`]{0,200}?(?:exit(?:\s+code)?\s+(\d+)|\b(all\s+pass(?:ed|ing)?|pass(?:ed|ing)?|fail(?:ed|ing)?)\b)/gi;
	let match: RegExpExecArray | null = re.exec(md);
	while (match) {
		const command = (match[1] ?? "").trim();
		const explicitExit = match[2] ? Number.parseInt(match[2], 10) : undefined;
		const keyword = match[3]?.toLowerCase();
		let expectedExit: number | undefined;
		if (explicitExit !== undefined) {
			expectedExit = explicitExit;
		} else if (keyword) {
			expectedExit = keyword.startsWith("fail") ? 1 : 0;
		}
		if (command.length >= 3 && expectedExit !== undefined) {
			pushIfNew(claims, seen, {
				raw: match[0],
				command,
				expectedExit,
			});
		}
		match = re.exec(md);
	}
}

interface EventLogRow {
	payload: string;
}

type EventPayload = Pick<
	ToolCallEvent,
	"toolCallId" | "toolName" | "input" | "isError" | "startedAt"
>;

function queryBashEvents(db: Database.Database, sliceId: string): EventPayload[] {
	const rows = db
		.prepare(
			`SELECT payload FROM event_log
			 WHERE channel = 'tff:tool'
			   AND slice_id = ?
			   AND json_extract(payload, '$.phase') = 'verify'
			   AND json_extract(payload, '$.toolName') = 'bash'`,
		)
		.all(sliceId) as EventLogRow[];

	const out: EventPayload[] = [];
	for (const r of rows) {
		try {
			out.push(JSON.parse(r.payload) as EventPayload);
		} catch {
			// Drop malformed rows silently — monitoring must not fail the pipeline.
		}
	}
	return out;
}

function commandsOverlap(claim: string, actual: string): boolean {
	const claimTokens = claim.trim().split(/\s+/).filter(Boolean);
	const actualTokens = actual.trim().split(/\s+/).filter(Boolean);

	// Single-token claims (e.g., "bun") are too generic for fuzzy match.
	// Require exact match when the claim is one token.
	if (claimTokens.length < 2 || actualTokens.length < 2) {
		return claim.trim() === actual.trim();
	}

	// Multi-token: accept exact match OR contiguous-token-prefix in either
	// direction. This captures legitimate paraphrase cases like
	// "bun run test" ↔ "bun run test --watch" while rejecting
	// "bun" matching "bun run test".
	const shorter = claimTokens.length <= actualTokens.length ? claimTokens : actualTokens;
	const longer = claimTokens.length <= actualTokens.length ? actualTokens : claimTokens;
	for (let i = 0; i < shorter.length; i++) {
		if (shorter[i] !== longer[i]) return false;
	}
	return true;
}

function matchClaim(claim: ParsedClaim, events: EventPayload[]): AuditFinding {
	const candidates = events.filter((e) => {
		const actual = (e.input as { command?: string } | null | undefined)?.command;
		if (typeof actual !== "string") return false;
		return commandsOverlap(claim.command, actual);
	});

	if (candidates.length === 0) {
		return {
			claim,
			verdict: "unverifiable",
			reason: `No bash tool call captured in the verify phase matched command \`${claim.command}\`.`,
		};
	}

	candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	const chosen = candidates[0];
	if (!chosen) {
		return {
			claim,
			verdict: "unverifiable",
			reason: "Internal: candidate list empty after sort.",
		};
	}

	const chosenCommand = (chosen.input as { command?: string } | null | undefined)?.command ?? "";
	const actualExit: 0 | 1 = chosen.isError ? 1 : 0;
	const evidence: AuditEvidence = {
		toolCallId: chosen.toolCallId,
		actualCommand: chosenCommand,
		actualExit,
		timestamp: chosen.startedAt,
	};

	if (claim.expectedExit === undefined) {
		return {
			claim,
			verdict: "unverifiable",
			evidence,
			reason: "Tool call captured, but the claim does not commit to a pass/fail outcome.",
		};
	}

	if (claim.expectedExit === actualExit) {
		return {
			claim,
			verdict: "match",
			evidence,
			reason: `Claim exit ${claim.expectedExit} matches captured exit ${actualExit}.`,
		};
	}

	return {
		claim,
		verdict: "mismatch",
		evidence,
		reason: `Claim expected exit ${claim.expectedExit}, but captured exit ${actualExit}.`,
	};
}

export function auditVerification(
	db: Database.Database,
	sliceId: string,
	verificationMd: string,
): AuditReport {
	const claims = parseVerificationClaims(verificationMd);
	const events = queryBashEvents(db, sliceId);
	const findings = claims.map((c) => matchClaim(c, events));

	const summary = { match: 0, mismatch: 0, unverifiable: 0 };
	for (const f of findings) summary[f.verdict] += 1;

	return {
		findings,
		summary,
		hasMismatches: summary.mismatch > 0,
	};
}

export function formatAuditReport(report: AuditReport): string {
	const lines: string[] = [];
	lines.push("# Verification Audit");
	lines.push("");
	lines.push(`**Generated:** ${new Date().toISOString()}`);
	lines.push(
		`**Summary:** ${report.summary.match} match, ${report.summary.mismatch} mismatch, ${report.summary.unverifiable} unverifiable`,
	);
	lines.push("");

	const mismatches = report.findings.filter((f) => f.verdict === "mismatch");
	const unverifiable = report.findings.filter((f) => f.verdict === "unverifiable");
	const matches = report.findings.filter((f) => f.verdict === "match");

	if (mismatches.length > 0) {
		lines.push("## Mismatches");
		lines.push("");
		for (const f of mismatches) {
			lines.push(`### Claim: \`${f.claim.command}\``);
			lines.push("");
			lines.push(`Line: ${f.claim.raw}`);
			if (f.evidence) {
				lines.push("");
				lines.push(`Evidence: tool-call \`${f.evidence.toolCallId}\` at ${f.evidence.timestamp}`);
				lines.push(`- Actual command: \`${f.evidence.actualCommand}\``);
				lines.push(`- Actual exit: ${f.evidence.actualExit}`);
			}
			lines.push("");
			lines.push(`Reason: ${f.reason}`);
			lines.push("");
		}
	}

	if (unverifiable.length > 0) {
		lines.push("## Unverifiable");
		lines.push("");
		for (const f of unverifiable) {
			lines.push(`- Claim: \`${f.claim.command}\` — ${f.reason}`);
		}
		lines.push("");
	}

	if (matches.length > 0) {
		lines.push("## Matches");
		lines.push("");
		for (const f of matches) {
			lines.push(`- \`${f.claim.command}\` — match (exit ${f.evidence?.actualExit ?? "?"})`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
