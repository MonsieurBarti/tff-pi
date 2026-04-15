import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { writeArtifact } from "../common/artifacts.js";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveMilestone } from "../common/db-resolvers.js";
import { getMilestone } from "../common/db.js";
import { milestoneLabel } from "../common/types.js";

export interface CompleteMilestoneChangesResult {
	success: boolean;
	message: string;
}

export async function handleCompleteMilestoneChanges(
	_pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	milestoneIdOrLabel: string,
	feedback: string,
): Promise<CompleteMilestoneChangesResult> {
	const milestone =
		getMilestone(db, milestoneIdOrLabel) ?? resolveMilestone(db, milestoneIdOrLabel);
	if (!milestone) {
		return { success: false, message: `Milestone not found: ${milestoneIdOrLabel}` };
	}
	if (milestone.status !== "completing") {
		return {
			success: false,
			message: `Milestone ${milestoneLabel(milestone.number)} is '${milestone.status}'. /tff complete-milestone-changes only runs for milestones awaiting PR review.`,
		};
	}
	if (!feedback || feedback.trim().length === 0) {
		return { success: false, message: "Empty feedback — nothing to record." };
	}

	const mLabel = milestoneLabel(milestone.number);
	writeArtifact(
		root,
		`milestones/${mLabel}/MILESTONE_REVIEW_FEEDBACK.md`,
		`# Milestone Review Feedback\n\n${feedback}\n`,
	);

	return {
		success: true,
		message: `Feedback recorded at milestones/${mLabel}/MILESTONE_REVIEW_FEEDBACK.md. Fix the issues manually (edit slices, push commits, etc.), then re-run /tff complete-milestone-merged ${mLabel} once the PR is merged.`,
	};
}

export async function runCompleteMilestoneChanges(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const project = requireProject(ctx, uiCtx);
	if (!project) return;
	const { db: database, root } = project;
	const label = args[0] ?? "";
	const feedback = args.slice(1).join(" ");
	if (!label || !feedback) {
		if (uiCtx?.hasUI)
			uiCtx.ui.notify(
				"Usage: /tff complete-milestone-changes <milestone-label> <feedback text>",
				"error",
			);
		return;
	}
	const result = await handleCompleteMilestoneChanges(pi, database, root, label, feedback);
	if (result.success) {
		pi.sendUserMessage(result.message);
	} else if (uiCtx?.hasUI) {
		uiCtx.ui.notify(result.message, "error");
	}
}
