import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveMilestone } from "../common/db-resolvers.js";
import { getMilestone, updateMilestoneStatus } from "../common/db.js";
import { getDefaultBranch } from "../common/git.js";
import { readProjectIdFile } from "../common/project-home.js";
import type { Settings } from "../common/settings.js";
import { finalizeStateBranchForMilestone } from "../common/state-ship.js";
import { milestoneLabel } from "../common/types.js";

export interface CompleteMilestoneMergedResult {
	success: boolean;
	message: string;
}

/**
 * User-attested milestone PR merge: finalizes the milestone's state branch
 * (merge into parent, archive-tag, delete refs) and closes the milestone.
 * Mirrors the pattern of `/tff ship-merged` — the user confirms the PR was
 * merged, we do the cleanup without consulting GitHub for merge state.
 */
export async function handleCompleteMilestoneMerged(
	_pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	milestoneIdOrLabel: string,
	settings?: Settings,
): Promise<CompleteMilestoneMergedResult> {
	const milestone =
		getMilestone(db, milestoneIdOrLabel) ?? resolveMilestone(db, milestoneIdOrLabel);
	if (!milestone) {
		return { success: false, message: `Milestone not found: ${milestoneIdOrLabel}` };
	}
	if (milestone.status === "closed") {
		return {
			success: false,
			message: `Milestone ${milestoneLabel(milestone.number)} is already closed.`,
		};
	}
	if (milestone.status !== "completing") {
		return {
			success: false,
			message: `Milestone ${milestoneLabel(milestone.number)} is '${milestone.status}'. Run /tff complete-milestone first to create the PR.`,
		};
	}

	const projectId = readProjectIdFile(root);
	if (!projectId) {
		return {
			success: false,
			message: "Project is not initialized (.tff-project-id missing). Run /tff init.",
		};
	}

	const parentBranch = settings?.milestone_target_branch ?? getDefaultBranch(root) ?? "main";

	const outcome = await finalizeStateBranchForMilestone({
		repoRoot: root,
		projectId,
		milestoneBranch: milestone.branch,
		parentBranch,
	});

	const mLabel = milestoneLabel(milestone.number);
	switch (outcome) {
		case "finalized":
			updateMilestoneStatus(db, milestone.id, "closed");
			return { success: true, message: `${mLabel} closed. State branch archived.` };
		case "finalized-local-only":
			updateMilestoneStatus(db, milestone.id, "closed");
			return {
				success: true,
				message:
					`${mLabel} closed. State branch archived locally. Remote cleanup may have failed — ` +
					`run 'git push origin :tff-state/${milestone.branch}' manually if needed.`,
			};
		case "skipped-no-state-branch":
			updateMilestoneStatus(db, milestone.id, "closed");
			return {
				success: true,
				message: `${mLabel} closed. (No state branch to archive.)`,
			};
		case "conflict-backup":
			return {
				success: false,
				message:
					`Parent-state merge conflict on tff-state/${parentBranch}. Live state branch preserved. ` +
					`Resolve manually, then re-run /tff complete-milestone-merged ${mLabel}.`,
			};
	}
}

export async function runCompleteMilestoneMerged(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root, settings: currentSettings } = project;
	const label = args[0] ?? "";
	if (!label) {
		if (uiCtx?.hasUI)
			uiCtx.ui.notify("Usage: /tff complete-milestone-merged <milestone-label>", "error");
		return;
	}
	const result = await handleCompleteMilestoneMerged(pi, database, root, label, currentSettings);
	if (result.success) {
		pi.sendUserMessage(result.message);
		if (uiCtx?.hasUI) uiCtx.ui.notify("Milestone closed.", "info");
	} else {
		if (uiCtx?.hasUI) uiCtx.ui.notify(result.message, "error");
	}
}
