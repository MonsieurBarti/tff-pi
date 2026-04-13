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

export function parseVerificationClaims(_md: string): ParsedClaim[] {
	// Filled in by Task 2.
	return [];
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
