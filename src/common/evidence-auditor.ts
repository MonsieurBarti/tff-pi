import type Database from "better-sqlite3";

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

export function auditVerification(
	_db: Database.Database,
	_sliceId: string,
	_verificationMd: string,
): AuditReport {
	// Filled in by Task 3.
	return {
		findings: [],
		summary: { match: 0, mismatch: 0, unverifiable: 0 },
		hasMismatches: false,
	};
}

export function formatAuditReport(_report: AuditReport): string {
	// Filled in by Task 3.
	return "";
}
