import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getPrTools } from "../common/gh-client.js";
import { parsePrUrl } from "../common/gh-helpers.js";
import { gitEnv } from "../common/git.js";
import { sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";
import { finalizeMergedSlice, suggestNextAction } from "../phases/ship.js";

export interface ShipMergedResult {
	success: boolean;
	message: string;
}

/**
 * User-attested PR merge: runs the same cleanup as the MERGED re-entry branch
 * of `shipPhase` without consulting GitHub for state. This is the standard
 * flow for manual-review projects — once the user confirms the PR was merged,
 * we reap the worktree, delete slice branches, pull the milestone, and close
 * the slice.
 *
 * We deliberately do NOT verify the merge STATE with `gh pr view` (users want
 * this to work even when gh auth is scoped to their browser). We DO however
 * do a best-effort squash check: if we can read the merge commit's parent
 * count, we warn (non-fatal) when a slice PR was merged with a merge commit —
 * that pollutes the milestone branch with intermediate per-task commits.
 */
export async function handleShipMerged(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	sliceIdOrLabel: string,
): Promise<ShipMergedResult> {
	const slice = getSlice(db, sliceIdOrLabel);
	if (!slice) {
		return { success: false, message: `Slice not found: ${sliceIdOrLabel}` };
	}
	if (slice.status === "closed") {
		return {
			success: false,
			message: `Slice ${sliceIdOrLabel} is already closed.`,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			success: false,
			message: `Milestone not found for slice ${sliceIdOrLabel}.`,
		};
	}

	const sLabel = sliceLabel(milestone.number, slice.number);
	const startTime = Date.now();

	// Best-effort squash check. Non-fatal: if we can't parse gh output or
	// the git command fails, don't block the cleanup.
	if (slice.prUrl) {
		const parsed = parsePrUrl(slice.prUrl);
		if (parsed) {
			try {
				const view = await getPrTools().view({ repo: parsed.repo, number: parsed.number });
				if (view.code === 0) {
					const pr = JSON.parse(view.stdout) as { mergeCommit?: { oid: string } | null };
					const oid = pr.mergeCommit?.oid;
					if (oid) {
						const parentsOutput = execFileSync("git", ["rev-list", "--parents", "-n", "1", oid], {
							cwd: root,
							encoding: "utf-8",
							env: gitEnv(),
						}).trim();
						const parentCount = parentsOutput.split(" ").length - 1;
						if (parentCount > 1) {
							pi.sendUserMessage(
								`WARNING: ${sLabel} PR was merged with a merge commit (${parentCount} parents). Slice PRs should be squash-merged — the milestone branch now contains intermediate per-task commits. Future slices will not repeat this if ship.merge_method is "squash" in .tff/settings.yaml (the default).`,
							);
						}
					}
				}
			} catch {
				// Non-fatal: network failure, bad JSON, commit not present locally, etc.
			}
		}
	}

	finalizeMergedSlice(db, root, slice, milestone.number);

	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestone.number),
		type: "phase_complete",
		phase: "ship",
		durationMs: Date.now() - startTime,
	});

	const next = suggestNextAction(db, slice.milestoneId);
	return {
		success: true,
		message: `${sLabel} closed. ${next}`,
	};
}

export async function runShipMerged(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root } = project;
	const label = args[0] ?? "";
	const slice = label ? resolveSlice(database, label) : findActiveSlice(database);
	if (!slice) {
		const msg = label ? `Slice not found: ${label}` : "No active slice found.";
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, "error");
		return;
	}
	const result = await handleShipMerged(pi, database, root, slice.id);
	if (result.success) {
		pi.sendUserMessage(`PR merged. ${result.message}`);
		if (uiCtx?.hasUI) uiCtx.ui.notify("Slice closed.", "info");
	} else {
		if (uiCtx?.hasUI) uiCtx.ui.notify(result.message, "error");
	}
}
