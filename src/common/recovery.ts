import type Database from "better-sqlite3";
import { readArtifact } from "./artifacts.js";
import { getLastCheckpoint, listCheckpoints } from "./checkpoint.js";
import { getMilestones, getProject, getSlice, getSlices } from "./db.js";
import type { Slice, SliceStatus } from "./types.js";
import { milestoneLabel, sliceLabel } from "./types.js";
import { getWorktreePath, worktreeExists } from "./worktree.js";

export const FORENSICS_MAX_COUNT = 10;
export const FORENSICS_WINDOW_MS = 30 * 60 * 1000;

export interface RecentToolCall {
	timestamp: string;
	toolName: string;
	commandSummary: string;
	isError: boolean;
	durationMs: number;
}

export function summarizeInput(toolName: string, input: unknown): string {
	if (input === null || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const truncate = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

	if (toolName === "bash") {
		return typeof obj.command === "string" ? truncate(obj.command) : "";
	}
	if (toolName === "write" || toolName === "edit" || toolName === "notebook_edit") {
		const p = obj.path ?? obj.file_path;
		return typeof p === "string" ? p : "";
	}
	if (toolName.startsWith("tff_write_")) {
		const artifact = toolName.replace(/^tff_write_/, "").toUpperCase();
		return `${artifact}.md`;
	}
	try {
		return truncate(JSON.stringify(obj));
	} catch {
		return "";
	}
}

const TRANSITIONAL_STATUSES: SliceStatus[] = [
	"discussing",
	"researching",
	"planning",
	"executing",
	"verifying",
	"reviewing",
	"shipping",
];

export type RecoveryClassification = "resume" | "rollback" | "skip" | "manual";

export interface RecoveryEvidence {
	worktreeExists: boolean;
	artifacts: string[];
	checkpoints: string[];
	lastCheckpoint: string | null;
}

export interface RecoveryDiagnosis {
	sliceId: string;
	sliceLabel: string;
	status: SliceStatus;
	classification: RecoveryClassification;
	evidence: RecoveryEvidence;
	recommendation: string;
}

export function scanForStuckSlices(db: Database.Database): Slice[] {
	const project = getProject(db);
	if (!project) return [];

	const milestones = getMilestones(db, project.id);
	const stuck: Slice[] = [];

	for (const m of milestones) {
		const slices = getSlices(db, m.id);
		for (const s of slices) {
			if (TRANSITIONAL_STATUSES.includes(s.status)) {
				stuck.push(s);
			}
		}
	}

	return stuck;
}

export function diagnoseRecovery(
	root: string,
	db: Database.Database,
	sliceId: string,
	milestoneNumber: number,
): RecoveryDiagnosis {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			sliceId,
			sliceLabel: "unknown",
			status: "created",
			classification: "manual",
			evidence: { worktreeExists: false, artifacts: [], checkpoints: [], lastCheckpoint: null },
			recommendation: "Slice not found in database.",
		};
	}

	const sLabel = sliceLabel(milestoneNumber, slice.number);
	const mLabel = milestoneLabel(milestoneNumber);
	const basePath = `milestones/${mLabel}/slices/${sLabel}`;

	const wtExists = worktreeExists(root, sLabel);
	const artifactNames = [
		"SPEC.md",
		"REQUIREMENTS.md",
		"PLAN.md",
		"RESEARCH.md",
		"VERIFICATION.md",
		"REVIEW.md",
	];
	const presentArtifacts = artifactNames.filter((name) => {
		const content = readArtifact(root, `${basePath}/${name}`);
		return content !== null && content.trim().length > 0;
	});

	const wtPath = getWorktreePath(root, sLabel);
	const checkpoints = wtExists ? listCheckpoints(wtPath, sLabel) : listCheckpoints(root, sLabel);
	const lastCheckpoint = wtExists
		? getLastCheckpoint(wtPath, sLabel)
		: getLastCheckpoint(root, sLabel);

	const evidence: RecoveryEvidence = {
		worktreeExists: wtExists,
		artifacts: presentArtifacts,
		checkpoints,
		lastCheckpoint,
	};

	const classification = classify(slice.status, evidence);
	const recommendation = buildRecommendation(classification, slice.status, sLabel, evidence);

	return {
		sliceId: slice.id,
		sliceLabel: sLabel,
		status: slice.status,
		classification,
		evidence,
		recommendation,
	};
}

function classify(status: SliceStatus, evidence: RecoveryEvidence): RecoveryClassification {
	if (["discussing", "researching", "planning"].includes(status)) {
		return "resume";
	}

	if (status === "shipping") {
		return "manual";
	}

	if (!evidence.worktreeExists) {
		return "manual";
	}

	if (evidence.checkpoints.length > 0) {
		return "resume";
	}

	if (status === "executing" || status === "verifying" || status === "reviewing") {
		return "resume";
	}

	return "manual";
}

function buildRecommendation(
	classification: RecoveryClassification,
	status: SliceStatus,
	sLabel: string,
	evidence: RecoveryEvidence,
): string {
	switch (classification) {
		case "resume":
			return `The ${status} phase on ${sLabel} can be re-run safely. ${
				evidence.lastCheckpoint
					? `Last checkpoint: ${evidence.lastCheckpoint}.`
					: "No checkpoints found — starting fresh."
			}`;
		case "rollback":
			return `Roll back to ${evidence.lastCheckpoint} and re-run the ${status} phase on ${sLabel}.`;
		case "skip":
			return `The ${status} phase on ${sLabel} appears to have completed. Fast-forwarding DB state.`;
		case "manual":
			return `Cannot determine the correct recovery action for ${sLabel} (status: ${status}). Please inspect the state manually.`;
	}
}

export function formatRecoveryBriefing(
	diagnosis: RecoveryDiagnosis,
	lockTimestamp?: string,
): string {
	const elapsed = lockTimestamp
		? `${Math.round((Date.now() - new Date(lockTimestamp).getTime()) / 60_000)} minutes ago`
		: "unknown";

	return [
		"## TFF Recovery — Interrupted Session Detected",
		"",
		`**What was running:** ${diagnosis.status} phase on ${diagnosis.sliceLabel}`,
		lockTimestamp ? `**Crashed at:** ${lockTimestamp} (${elapsed})` : "",
		diagnosis.evidence.lastCheckpoint
			? `**Last checkpoint:** ${diagnosis.evidence.lastCheckpoint}`
			: "",
		"",
		"### Evidence",
		`- Worktree: ${diagnosis.evidence.worktreeExists ? "exists" : "missing"}`,
		`- Artifacts: ${diagnosis.evidence.artifacts.length > 0 ? diagnosis.evidence.artifacts.join(", ") : "none"}`,
		`- Checkpoints: ${diagnosis.evidence.checkpoints.length > 0 ? diagnosis.evidence.checkpoints.join(", ") : "none"}`,
		"",
		`### Recommendation: ${diagnosis.classification}`,
		diagnosis.recommendation,
		"",
		`To proceed: run \`/tff recover ${diagnosis.classification}\` or \`/tff recover dismiss\``,
	]
		.filter(Boolean)
		.join("\n");
}
