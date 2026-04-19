import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import {
	type PhaseRun,
	applyMigrations,
	getMilestones,
	getPhaseRuns,
	getProject,
	getSlices,
	openDatabase,
	recoverOrphanedPhaseRuns,
	updatePhaseRun,
} from "../common/db.js";
import { computeSliceStatus, reconcileSliceStatus } from "../common/derived-state.js";
import { readEventsWithPositions } from "../common/event-log.js";
import { logWarning } from "../common/logger.js";
import { validateCommandPreconditions } from "../common/preconditions.js";
import { UnknownCommandError, projectCommand } from "../common/projection.js";
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

export interface LogDrift {
	sliceId: string;
	sliceLabel: string;
	field: "phase_run_count" | "phase_run_status";
	phase?: string;
	live: string;
	replayed: string;
}

export interface InvariantViolation {
	cmd: string;
	row: number;
	reason: string;
}

export interface DoctorReport {
	ok: boolean;
	stalledPhases: StalledPhase[];
	drifts: SliceDrift[];
	logDrifts: LogDrift[];
	invariantViolations: InvariantViolation[];
	message: string;
}

export function buildShadowDb(root: string): Database.Database {
	const shadow = openDatabase(":memory:");
	applyMigrations(shadow);
	const events = readEventsWithPositions(root, 0);
	for (const { event } of events) {
		try {
			projectCommand(shadow, root, event.cmd, event.params as Record<string, unknown>);
		} catch (err) {
			if (!(err instanceof UnknownCommandError)) {
				logWarning("doctor", "shadow-projection-failed", {
					cmd: event.cmd,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return shadow;
}

export function checkLogProjectionDrift(
	db: Database.Database,
	shadowDb: Database.Database,
): LogDrift[] {
	const drifts: LogDrift[] = [];
	const project = getProject(db);
	if (!project) return drifts;

	const shadowProject = getProject(shadowDb);

	const milestones = getMilestones(db, project.id);
	for (const m of milestones) {
		const slices = getSlices(db, m.id);
		for (const s of slices) {
			const label = sliceLabel(m.number, s.number);
			const liveRuns = getPhaseRuns(db, s.id);

			// Correlate by milestone/slice number, not by ID, since shadow DB has
			// its own auto-generated UUIDs.
			let shadowRuns: ReturnType<typeof getPhaseRuns> = [];
			if (shadowProject) {
				const shadowMilestone = getMilestones(shadowDb, shadowProject.id).find(
					(sm) => sm.number === m.number,
				);
				if (shadowMilestone) {
					const shadowSlice = getSlices(shadowDb, shadowMilestone.id).find(
						(ss) => ss.number === s.number,
					);
					if (shadowSlice) {
						shadowRuns = getPhaseRuns(shadowDb, shadowSlice.id);
					}
				}
			}

			const liveActiveRuns = liveRuns.filter((r) => r.status !== "abandoned");

			if (liveActiveRuns.length !== shadowRuns.length) {
				drifts.push({
					sliceId: s.id,
					sliceLabel: label,
					field: "phase_run_count",
					live: String(liveActiveRuns.length),
					replayed: String(shadowRuns.length),
				});
				continue;
			}

			for (const liveRun of liveActiveRuns) {
				const shadowRun = shadowRuns.find((r) => r.phase === liveRun.phase);
				if (!shadowRun) continue;
				if (shadowRun.status !== liveRun.status && liveRun.status !== "abandoned") {
					drifts.push({
						sliceId: s.id,
						sliceLabel: label,
						field: "phase_run_status",
						phase: liveRun.phase,
						live: liveRun.status,
						replayed: shadowRun.status,
					});
				}
			}
		}
	}

	return drifts;
}

export function checkInvariantSweep(
	root: string,
	sweepDbFactory?: () => Database.Database,
): InvariantViolation[] {
	const violations: InvariantViolation[] = [];
	const sweepDb = sweepDbFactory ? sweepDbFactory() : openDatabase(":memory:");
	applyMigrations(sweepDb);

	const events = readEventsWithPositions(root, 0);
	for (const { event, physicalLine } of events) {
		const result = validateCommandPreconditions(
			sweepDb,
			root,
			event.cmd,
			event.params as Record<string, unknown>,
		);
		if (!result.ok) {
			violations.push({
				cmd: event.cmd,
				row: physicalLine + 1,
				reason: result.reason ?? "precondition failed",
			});
		}
		try {
			projectCommand(sweepDb, root, event.cmd, event.params as Record<string, unknown>);
		} catch (err) {
			if (!(err instanceof UnknownCommandError)) {
				logWarning("doctor", "sweep-projection-failed", {
					cmd: event.cmd,
					row: String(physicalLine + 1),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	return violations;
}

/**
 * Scans phase_run for any entry still marked 'started' past STALLED_THRESHOLD_MS.
 * These are phases the agent started but never signalled complete for — typically
 * because the agent exited without calling its writer tool (tff_write_plan, etc.).
 */
export function handleDoctor(
	db: Database.Database,
	options: { repair?: boolean; now?: number; root?: string } = {},
): DoctorReport {
	// Invariant sweep is independent of the live DB project — compute it first
	// so even the "no project" early return can surface event-log violations.
	const invariantViolations: InvariantViolation[] = options.root
		? checkInvariantSweep(options.root)
		: [];

	const project = getProject(db);
	if (!project) {
		return {
			ok: invariantViolations.length === 0,
			stalledPhases: [],
			drifts: [],
			logDrifts: [],
			invariantViolations,
			message:
				invariantViolations.length > 0
					? `No project yet. Run \`/tff new\` to create one.\n- Invariant violations (${invariantViolations.length}): manual investigation required`
					: "No project yet. Run `/tff new` to create one.",
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
					if (options.repair) {
						reconcileSliceStatus(db, options.root, s.id);
					}
				}
			}
		}
	}

	const logDrifts: LogDrift[] = options.root
		? checkLogProjectionDrift(db, buildShadowDb(options.root))
		: [];

	if (stalled.length === 0) {
		const verb = options.repair ? "Reconciled" : "Detected";
		const allClear =
			drifts.length === 0 && logDrifts.length === 0 && invariantViolations.length === 0;
		const lines: string[] = [
			`TFF doctor: ${allClear ? "OK" : options.repair ? "reconciled drift" : "drift detected"}`,
			`- ${milestones.length} milestone(s), no stalled phases.`,
			`- Stall threshold: ${Math.round(STALLED_THRESHOLD_MS / 60000)} minutes.`,
		];
		if (drifts.length > 0) {
			lines.push(
				`- ${verb} ${drifts.length} slice(s) with drifted status${options.repair ? "" : " (run /tff doctor --repair to reconcile)"}:`,
			);
			for (const d of drifts) {
				lines.push(`    ${d.sliceLabel}: ${d.from} → ${d.to}`);
			}
		}
		if (logDrifts.length > 0) {
			lines.push(`- Log/projection drift (${logDrifts.length}): manual investigation required`);
			for (const d of logDrifts) {
				const detail =
					d.field === "phase_run_status"
						? `${d.sliceLabel} (${d.phase ?? "?"}): live=${d.live} replayed=${d.replayed}`
						: `${d.sliceLabel} (phase_run_count): live=${d.live} replayed=${d.replayed}`;
				lines.push(`    ${detail}`);
			}
		} else {
			lines.push("- Log/projection drift (0): none.");
		}
		if (invariantViolations.length > 0) {
			lines.push(
				`- Invariant violations (${invariantViolations.length}): manual investigation required`,
			);
			for (const v of invariantViolations) {
				lines.push(`    row ${v.row}: ${v.cmd} — ${v.reason}`);
			}
		} else {
			lines.push("- Invariant violations (0): none.");
		}
		return {
			ok:
				(drifts.length === 0 && logDrifts.length === 0 && invariantViolations.length === 0) ||
				!!options.repair,
			stalledPhases: [],
			drifts,
			logDrifts,
			invariantViolations,
			message: lines.join("\n"),
		};
	}

	if (options.repair) {
		const count = recoverOrphanedPhaseRuns(db);
		return {
			ok: true,
			stalledPhases: stalled,
			drifts,
			logDrifts,
			invariantViolations,
			message: formatStalledReport(stalled, {
				recovered: count,
				drifts,
				repair: true,
				logDrifts,
				invariantViolations,
			}),
		};
	}

	return {
		ok: false,
		stalledPhases: stalled,
		drifts,
		logDrifts,
		invariantViolations,
		message: formatStalledReport(stalled, {
			drifts,
			repair: false,
			logDrifts,
			invariantViolations,
		}),
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
	opts: {
		recovered?: number;
		drifts?: SliceDrift[];
		repair?: boolean;
		logDrifts?: LogDrift[];
		invariantViolations?: InvariantViolation[];
	} = {},
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
		lines.push("Run `/tff doctor --repair` to mark these as abandoned.");
	}

	const drifts = opts.drifts ?? [];
	if (drifts.length > 0) {
		const verb = opts.repair ? "Reconciled" : "Detected";
		lines.push("");
		lines.push(
			`${verb} ${drifts.length} slice(s) with drifted status${opts.repair ? "" : " (run /tff doctor --repair to reconcile)"}:`,
		);
		for (const d of drifts) {
			lines.push(`    ${d.sliceLabel}: ${d.from} → ${d.to}`);
		}
	}

	const logDrifts = opts.logDrifts ?? [];
	if (logDrifts.length > 0) {
		lines.push(`- Log/projection drift (${logDrifts.length}): manual investigation required`);
		for (const d of logDrifts) {
			const detail =
				d.field === "phase_run_status"
					? `${d.sliceLabel} (${d.phase ?? "?"}): live=${d.live} replayed=${d.replayed}`
					: `${d.sliceLabel} (phase_run_count): live=${d.live} replayed=${d.replayed}`;
			lines.push(`    ${detail}`);
		}
	} else {
		lines.push("- Log/projection drift (0): none.");
	}

	const invariantViolations = opts.invariantViolations ?? [];
	if (invariantViolations.length > 0) {
		lines.push(
			`- Invariant violations (${invariantViolations.length}): manual investigation required`,
		);
		for (const v of invariantViolations) {
			lines.push(`    row ${v.row}: ${v.cmd} — ${v.reason}`);
		}
	} else {
		lines.push("- Invariant violations (0): none.");
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
		const repair = args.includes("--repair");
		const usedLegacyFlag = args.includes("--recover");
		if (usedLegacyFlag) {
			logWarning("doctor", "unknown-flag", { cmd: "--recover" });
		}
		const root = ctx.projectRoot ?? undefined;
		const report = handleDoctor(getDb(ctx), root !== undefined ? { repair, root } : { repair });
		msg = report.message;
		if (usedLegacyFlag) {
			msg = `WARNING: --recover is deprecated. Use --repair instead.\n\n${msg}`;
		}
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
