import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import {
	type PhaseRun,
	getMilestones,
	getPhaseRuns,
	getProject,
	getSlices,
	recoverOrphanedPhaseRuns,
	updatePhaseRun,
} from "../common/db.js";
import { computeSliceStatus, reconcileSliceStatus } from "../common/derived-state.js";
import { isStateBranchEnabledForRoot } from "../common/state-branch-toggle.js";
import { type SliceStatus, sliceLabel } from "../common/types.js";

/**
 * Milliseconds after which a phase_run still in 'started' state is considered
 * stalled. 10 minutes is long enough for a reasonable LLM turn but short enough
 * that a human running `/tff doctor` will notice real hangs quickly.
 */
export const STALLED_THRESHOLD_MS = 10 * 60 * 1000;

export interface StalledPhase {
	sliceId: string;
	sliceLabel: string;
	phase: string;
	startedAt: string;
	ageMs: number;
}

export interface SliceDrift {
	sliceId: string;
	sliceLabel: string;
	from: SliceStatus;
	to: SliceStatus;
}

export interface DoctorReport {
	ok: boolean;
	stalledPhases: StalledPhase[];
	drifts: SliceDrift[];
	message: string;
}

/**
 * Scans phase_run for any entry still marked 'started' past STALLED_THRESHOLD_MS.
 * These are phases the agent started but never signalled complete for — typically
 * because the agent exited without calling its writer tool (tff_write_plan, etc.).
 */
export function handleDoctor(
	db: Database.Database,
	options: { recover?: boolean; now?: number; root?: string } = {},
): DoctorReport {
	const project = getProject(db);
	if (!project) {
		return {
			ok: true,
			stalledPhases: [],
			drifts: [],
			message: "No project yet. Run `/tff new` to create one.",
		};
	}

	const now = options.now ?? Date.now();
	const milestones = getMilestones(db, project.id);
	const stalled: StalledPhase[] = [];

	for (const m of milestones) {
		const slices = getSlices(db, m.id);
		for (const s of slices) {
			if (s.status === "closed") {
				// Closed slices cannot transition; any 'started' phase_run on them
				// is an orphan. Sweep to 'abandoned' so doctor stops reporting it
				// as a stall forever. Idempotent — only touches status='started'.
				const runs = getPhaseRuns(db, s.id);
				const nowIso = new Date(now).toISOString();
				for (const run of runs) {
					if (run.status === "started") {
						// Intentional: doctor is an explicit repair tool operating outside the command-log invariants.
						updatePhaseRun(db, run.id, {
							status: "abandoned",
							finishedAt: nowIso,
						});
					}
				}
				continue;
			}
			const runs = getPhaseRuns(db, s.id);
			for (const run of runs) {
				if (!isStalled(run, now)) continue;
				stalled.push({
					sliceId: s.id,
					sliceLabel: sliceLabel(m.number, s.number),
					phase: run.phase,
					startedAt: run.startedAt,
					ageMs: now - Date.parse(run.startedAt),
				});
			}
		}
	}

	const drifts: SliceDrift[] = [];
	if (options.root) {
		for (const m of milestones) {
			const slices = getSlices(db, m.id);
			for (const s of slices) {
				// Preserve override-to-closed terminal safety: closed slices are never
				// reconciled. See overrideSliceStatus docstring.
				if (s.status === "closed") continue;
				const computed = computeSliceStatus(db, options.root, s.id);
				if (computed !== s.status) {
					drifts.push({
						sliceId: s.id,
						sliceLabel: sliceLabel(m.number, s.number),
						from: s.status,
						to: computed,
					});
					if (options.recover) {
						reconcileSliceStatus(db, options.root, s.id);
					}
				}
			}
		}
	}

	if (stalled.length === 0) {
		const verb = options.recover ? "Reconciled" : "Detected";
		const lines: string[] = [
			`TFF doctor: ${drifts.length === 0 ? "OK" : options.recover ? "reconciled drift" : "drift detected"}`,
			`- ${milestones.length} milestone(s), no stalled phases.`,
			`- Stall threshold: ${Math.round(STALLED_THRESHOLD_MS / 60000)} minutes.`,
		];
		if (drifts.length > 0) {
			lines.push(
				`- ${verb} ${drifts.length} slice(s) with drifted status${options.recover ? "" : " (run /tff doctor --recover to reconcile)"}:`,
			);
			for (const d of drifts) {
				lines.push(`    ${d.sliceLabel}: ${d.from} → ${d.to}`);
			}
		}
		return {
			ok: drifts.length === 0 || !!options.recover,
			stalledPhases: [],
			drifts,
			message: lines.join("\n"),
		};
	}

	if (options.recover) {
		const count = recoverOrphanedPhaseRuns(db);
		return {
			ok: true,
			stalledPhases: stalled,
			drifts,
			message: formatStalledReport(stalled, { recovered: count, drifts, recover: true }),
		};
	}

	return {
		ok: false,
		stalledPhases: stalled,
		drifts,
		message: formatStalledReport(stalled, { drifts, recover: false }),
	};
}

function isStalled(run: PhaseRun, now: number): boolean {
	if (run.status !== "started") return false;
	const started = Date.parse(run.startedAt);
	if (Number.isNaN(started)) return false;
	return now - started > STALLED_THRESHOLD_MS;
}

function formatStalledReport(
	stalled: StalledPhase[],
	opts: { recovered?: number; drifts?: SliceDrift[]; recover?: boolean } = {},
): string {
	const lines: string[] = [];
	if (opts.recovered !== undefined) {
		lines.push(`TFF doctor: recovered ${opts.recovered} stalled phase_run(s).`);
		lines.push("");
	} else {
		lines.push(`TFF doctor: ${stalled.length} stalled phase(s) detected.`);
		lines.push("");
	}

	for (const p of stalled) {
		const mins = Math.round(p.ageMs / 60000);
		lines.push(`  ⚠ ${p.sliceLabel} — ${p.phase} started ${mins}m ago, not completed.`);
		lines.push("    Likely cause: agent exited without calling its writer tool.");
		lines.push(`    Fix: /tff ${p.phase} ${p.sliceLabel}    (re-runs the phase)`);
		lines.push("");
	}

	if (opts.recovered === undefined) {
		lines.push("Run `/tff doctor --recover` to mark these as abandoned.");
	}

	const drifts = opts.drifts ?? [];
	if (drifts.length > 0) {
		const verb = opts.recover ? "Reconciled" : "Detected";
		lines.push("");
		lines.push(
			`${verb} ${drifts.length} slice(s) with drifted status${opts.recover ? "" : " (run /tff doctor --recover to reconcile)"}:`,
		);
		for (const d of drifts) {
			lines.push(`    ${d.sliceLabel}: ${d.from} → ${d.to}`);
		}
	}

	return lines.join("\n");
}

/**
 * Returns a warning string when state_branch is disabled in settings but
 * tff-state/* refs still exist locally (stale from a previous enable).
 * Returns null when the toggle is on or when no stale refs are found.
 */
function collectStaleStateBranchWarning(root: string): string | null {
	if (isStateBranchEnabledForRoot(root)) return null;
	let raw: string;
	try {
		raw = execFileSync(
			"git",
			["-C", root, "for-each-ref", "refs/heads/tff-state/", "--format=%(refname:short)"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).toString();
	} catch {
		return null;
	}
	const refs = raw
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	if (refs.length === 0) return null;
	return [
		`WARNING: state_branch is disabled (settings.yaml) but ${refs.length} stale tff-state/* ref(s) exist locally:`,
		...refs.map((r) => `    ${r}`),
		"  Delete with: git branch -D <name>",
		"  Or re-enable state branches: set state_branch.enabled: true in settings.yaml",
	].join("\n");
}

export async function runDoctor(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	let msg: string;
	try {
		const recover = args.includes("--recover");
		const root = ctx.projectRoot ?? undefined;
		const report = handleDoctor(getDb(ctx), root !== undefined ? { recover, root } : { recover });
		msg = report.message;
	} catch (err) {
		msg = `TFF doctor: error — ${err instanceof Error ? err.message : String(err)}`;
	}
	if (uiCtx?.hasUI) {
		uiCtx.ui.notify(msg, "info");
	}
	pi.sendUserMessage(msg);

	const root = ctx.projectRoot;
	if (root) {
		const staleWarning = collectStaleStateBranchWarning(root);
		if (staleWarning) pi.sendUserMessage(staleWarning);
	}
}
