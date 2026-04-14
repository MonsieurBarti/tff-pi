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
} from "../common/db.js";
import { computeSliceStatus, reconcileSliceStatus } from "../common/derived-state.js";
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
}
