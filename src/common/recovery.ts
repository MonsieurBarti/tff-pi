import type Database from "better-sqlite3";
import { readArtifact } from "./artifacts.js";
import { getLastCheckpoint, listCheckpoints } from "./checkpoint.js";
import { getMilestone, getMilestones, getProject, getSlice, getSlices } from "./db.js";
import { readPerSliceLog } from "./per-slice-log.js";
import type { Slice, SliceStatus } from "./types.js";
import { milestoneLabel, sliceLabel } from "./types.js";
import { getWorktreePath, worktreeExists } from "./worktree.js";

const FORENSICS_MAX_COUNT = 10;
const FORENSICS_WINDOW_MS = 30 * 60 * 1000;

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
	// Strip C0 + DEL control chars AND CSI ANSI escapes (ESC[...letter).
	// Keeps command summaries readable in terminals and prevents control-char
	// bleed into the briefing. Built via RegExp ctor to avoid static analysis
	// flagging literal control chars in a regex.
	const ansiCsi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
	const ctrl = new RegExp(
		`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
		"g",
	);
	const sanitize = (s: string): string => s.replace(ansiCsi, "").replace(ctrl, " ");

	const truncate = (s: string, n = 80) => {
		const clean = sanitize(s);
		if (clean.length <= n) return clean;
		// Avoid splitting a UTF-16 surrogate pair at the cut boundary.
		let end = n;
		const last = clean.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		return `${clean.slice(0, end)}…`;
	};

	if (toolName === "bash") {
		return typeof obj.command === "string" ? truncate(obj.command) : "";
	}
	if (toolName === "write" || toolName === "edit" || toolName === "notebook_edit") {
		const p = obj.path ?? obj.file_path;
		return typeof p === "string" ? sanitize(p) : "";
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
	recentToolCalls: RecentToolCall[];
}

function queryRecentToolCalls(root: string, label: string): RecentToolCall[] {
	const cutoffMs = Date.now() - FORENSICS_WINDOW_MS;
	const all = readPerSliceLog(root, label).filter((l) => l.ch === "tff:tool");

	// Primary window: events within the last FORENSICS_WINDOW_MS
	const withinWindow = all.filter((p) => {
		const sa = p.startedAt;
		return typeof sa === "string" && Date.parse(sa) >= cutoffMs;
	});
	const chosen = withinWindow.length > 0 ? withinWindow : all;

	// Sort descending by startedAt, then cap to FORENSICS_MAX_COUNT
	const sorted = [...chosen].sort((a, b) =>
		String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")),
	);
	const capped = sorted.slice(0, FORENSICS_MAX_COUNT);

	const out: RecentToolCall[] = [];
	for (const p of capped) {
		if (typeof p.startedAt !== "string" || typeof p.toolName !== "string") continue;
		out.push({
			timestamp: p.startedAt,
			toolName: p.toolName,
			commandSummary: summarizeInput(p.toolName, p.input),
			isError: Boolean(p.isError),
			durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
		});
	}

	// Return in chronological order (oldest first) to match original behaviour
	return out.reverse();
}

export interface RecoveryDiagnosis {
	sliceId: string;
	sliceLabel: string;
	status: SliceStatus;
	classification: RecoveryClassification;
	evidence: RecoveryEvidence;
	recommendation: string;
	milestoneBranch?: string; // actual git branch (UUID-form post-M11-S04)
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
			evidence: {
				worktreeExists: false,
				artifacts: [],
				checkpoints: [],
				lastCheckpoint: null,
				recentToolCalls: [],
			},
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
		recentToolCalls: queryRecentToolCalls(root, sLabel),
	};

	const classification = classify(slice.status, evidence);
	const recommendation = buildRecommendation(classification, slice.status, sLabel, evidence);

	const milestoneRow = getMilestone(db, slice.milestoneId);

	const result: RecoveryDiagnosis = {
		sliceId: slice.id,
		sliceLabel: sLabel,
		status: slice.status,
		classification,
		evidence,
		recommendation,
	};

	if (milestoneRow?.branch) {
		// Read milestone.branch (DB-truthful) rather than deriving via the
		// branch-naming helper: the briefing must show the agent the exact ref
		// `git diff` will resolve, including legacy/fixture rows whose branch
		// was persisted before M11-S04's UUID convention.
		result.milestoneBranch = milestoneRow.branch;
	}

	return result;
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

	const lines: string[] = [
		"## TFF Recovery — Interrupted Session Detected",
		"",
		`**What was running:** ${diagnosis.status} phase on ${diagnosis.sliceLabel}`,
	];
	if (lockTimestamp) {
		lines.push(`**Crashed at:** ${lockTimestamp} (${elapsed})`);
	}
	if (diagnosis.evidence.lastCheckpoint) {
		lines.push(`**Last checkpoint:** ${diagnosis.evidence.lastCheckpoint}`);
	}
	lines.push("");
	lines.push("### Evidence");
	lines.push(`- Worktree: ${diagnosis.evidence.worktreeExists ? "exists" : "missing"}`);
	lines.push(
		`- Artifacts: ${diagnosis.evidence.artifacts.length > 0 ? diagnosis.evidence.artifacts.join(", ") : "none"}`,
	);
	lines.push(
		`- Checkpoints: ${diagnosis.evidence.checkpoints.length > 0 ? diagnosis.evidence.checkpoints.join(", ") : "none"}`,
	);

	if (diagnosis.evidence.recentToolCalls.length > 0) {
		lines.push("");
		lines.push(`### Recent tool calls (last ${diagnosis.evidence.recentToolCalls.length})`);
		for (const tc of diagnosis.evidence.recentToolCalls) {
			const marker = tc.isError ? "✗" : "✓";
			const time = tc.timestamp.slice(11, 19);
			const dur = tc.durationMs > 0 ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : "";
			const safeCmd = tc.commandSummary.replace(/`/g, "'");
			const cmd = safeCmd ? ` \`${safeCmd}\`` : "";
			lines.push(`- ${time} ${tc.toolName}${cmd} ${marker}${dur}`);
		}
	}

	// For commit-requiring phases, remind the agent about git discipline so that
	// /tff verify can find the diff even when recovery delivers this brief
	// instead of the full execute/ship prompt.
	if (diagnosis.status === "executing" || diagnosis.status === "shipping") {
		// Derive the milestone label from the slice label (e.g. "M01-S02" → "M01").
		// sliceLabel format is "Mnn-Snn"; split on "-" to grab the first part.
		const mLabel = diagnosis.sliceLabel.split("-")[0] ?? diagnosis.sliceLabel;
		const milestoneBranch = diagnosis.milestoneBranch ?? `milestone/${mLabel}`;
		lines.push("");
		lines.push("### Git discipline reminder");
		lines.push("");
		lines.push(
			`This phase requires git commits. Before \`/tff verify\` runs \`git diff ${milestoneBranch}...HEAD\`, make sure every code change has been \`git add\`-ed and \`git commit\`-ed in the slice worktree. Untracked files do NOT count as changes.`,
		);
	}

	lines.push("");
	lines.push(`### Recommendation: ${diagnosis.classification}`);
	lines.push(diagnosis.recommendation);
	lines.push("");
	lines.push(
		`To proceed: run \`/tff recover ${diagnosis.classification}\` or \`/tff recover dismiss\``,
	);

	return lines.join("\n");
}
