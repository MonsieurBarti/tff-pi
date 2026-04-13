import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { readArtifact } from "../common/artifacts.js";
import { type TffContext, getDb, resolveMilestone } from "../common/context.js";
import {
	getActiveMilestone,
	getMilestone,
	getProject,
	getSlices,
	updateMilestoneStatus,
	updateSliceStatus,
} from "../common/db.js";
import { getPrTools } from "../common/gh-client.js";
import { parsePrUrl } from "../common/gh-helpers.js";
import { getDefaultBranch, gitEnv } from "../common/git.js";
import { DEFAULT_SETTINGS, type Settings } from "../common/settings.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";

export interface CompleteMilestoneResult {
	success: boolean;
	prUrl?: string;
	error?: string;
}

export async function handleCompleteMilestone(
	db: Database.Database,
	root: string,
	milestoneId: string,
	settings: Settings,
): Promise<CompleteMilestoneResult> {
	// 1. Get milestone
	const milestone = getMilestone(db, milestoneId);
	if (!milestone) return { success: false, error: `Milestone not found: ${milestoneId}` };

	const slices = getSlices(db, milestoneId);
	if (slices.length === 0) return { success: false, error: "No slices in this milestone." };

	const env = gitEnv();
	const mLabel = milestoneLabel(milestone.number);

	// 2. Self-healing: check stale slices
	const openSlices = slices.filter((s) => s.status !== "closed");
	for (const slice of openSlices) {
		if (slice.prUrl) {
			const parsed = parsePrUrl(slice.prUrl);
			if (parsed) {
				try {
					const pr = getPrTools();
					const viewResult = await pr.view({ repo: parsed.repo, number: parsed.number });
					if (viewResult.code === 0) {
						const prData = JSON.parse(viewResult.stdout) as { state: string };
						if (prData.state === "MERGED") {
							updateSliceStatus(db, slice.id, "closed");
						}
					}
				} catch {
					// Cannot check PR — leave as-is
				}
			}
		}
	}

	// 3. Re-check after self-healing
	const stillOpen = getSlices(db, milestoneId).filter((s) => s.status !== "closed");
	if (stillOpen.length > 0) {
		const details = stillOpen
			.map((s) => `- ${sliceLabel(milestone.number, s.number)}: ${s.status}`)
			.join("\n");
		return { success: false, error: `${stillOpen.length} slice(s) not closed:\n${details}` };
	}

	// 4. Validate artifacts
	const artifactErrors: string[] = [];
	const requiredArtifacts = [
		"SPEC.md",
		"PLAN.md",
		"REQUIREMENTS.md",
		"VERIFICATION.md",
		"REVIEW.md",
	];
	for (const slice of slices) {
		const sLabel = sliceLabel(milestone.number, slice.number);
		const base = `milestones/${mLabel}/slices/${sLabel}`;
		for (const artifact of requiredArtifacts) {
			const content = readArtifact(root, `${base}/${artifact}`);
			if (!content || content.trim().length === 0) {
				artifactErrors.push(`${sLabel}: ${artifact} missing`);
			}
		}
	}
	if (artifactErrors.length > 0) {
		return {
			success: false,
			error: `Missing artifact(s):\n${artifactErrors.map((e) => `- ${e}`).join("\n")}`,
		};
	}

	// 5. Create milestone PR
	const targetBranch = settings.milestone_target_branch ?? getDefaultBranch(root) ?? "main";
	const prBody = slices
		.map(
			(s) =>
				`- ${sliceLabel(milestone.number, s.number)}: ${s.title}${s.prUrl ? ` (${s.prUrl})` : ""}`,
		)
		.join("\n");

	try {
		execFileSync("git", ["push", "-u", "origin", milestone.branch], {
			cwd: root,
			encoding: "utf-8",
			env,
		});

		// Derive repo slug from origin remote (gh-pi requires explicit repo)
		const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: root,
			encoding: "utf-8",
			env,
		}).trim();
		const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
		if (!repoMatch || !repoMatch[1]) {
			return { success: false, error: `Cannot parse repo from remote: ${remoteUrl}` };
		}
		const repo = repoMatch[1];

		const pr = getPrTools();
		const createResult = await pr.create({
			repo,
			title: `milestone(${mLabel}): ${milestone.name}`,
			body: `## Milestone: ${milestone.name}\n\n### Slices\n${prBody}`,
			head: milestone.branch,
			base: targetBranch,
		});
		if (createResult.code !== 0) {
			return { success: false, error: `gh pr create failed: ${createResult.stderr}` };
		}
		const prUrl = createResult.stdout.trim();
		updateMilestoneStatus(db, milestoneId, "completing");
		return { success: true, prUrl };
	} catch (err) {
		return {
			success: false,
			error: `Failed to create milestone PR: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export async function runCompleteMilestone(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const database = getDb(ctx);
	const root = ctx.projectRoot;
	if (!root) {
		if (uiCtx?.hasUI) uiCtx.ui.notify("Not inside a git repository.", "error");
		return;
	}
	const label = args[0] ?? "";
	const project = getProject(database);
	if (!project) {
		if (uiCtx?.hasUI) uiCtx.ui.notify("No project found. Run /tff new first.", "error");
		return;
	}
	const milestone = label
		? resolveMilestone(database, label)
		: getActiveMilestone(database, project.id);
	if (!milestone) {
		const msg = label ? `Milestone not found: ${label}` : "No active milestone found.";
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, "error");
		return;
	}
	const currentSettings = ctx.settings ?? DEFAULT_SETTINGS;
	const result = await handleCompleteMilestone(database, root, milestone.id, currentSettings);
	if (result.success) {
		pi.sendUserMessage(
			`Milestone ${milestoneLabel(milestone.number)} "${milestone.name}" PR created: ${result.prUrl}`,
		);
	} else {
		pi.sendUserMessage(`Cannot complete milestone: ${result.error}`);
	}
}
