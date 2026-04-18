import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { readArtifact } from "../common/artifacts.js";
import { type TffContext, requireProject } from "../common/context.js";
import { resolveMilestone } from "../common/db-resolvers.js";
import { getActiveMilestone, getMilestone, getProject, getSlices } from "../common/db.js";
import { appendCommand, updateLogCursor } from "../common/event-log.js";
import { makeBaseEvent } from "../common/events.js";
import { getPrTools } from "../common/gh-client.js";
import { parsePrUrl } from "../common/gh-helpers.js";
import { getDefaultBranch, gitEnv } from "../common/git.js";
import { projectCommand } from "../common/projection.js";
import type { Settings } from "../common/settings.js";
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
	pi: ExtensionAPI,
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
							const sLabel = sliceLabel(milestone.number, slice.number);
							db.transaction(() => {
								projectCommand(db, root, "override-status", {
									sliceId: slice.id,
									status: "closed",
									reason: "milestone-close",
								});
								const { hash, row } = appendCommand(root, "override-status", {
									sliceId: slice.id,
									status: "closed",
									reason: "milestone-close",
								});
								updateLogCursor(db, hash, row);
							})();
							pi.events.emit("tff:override", {
								...makeBaseEvent(slice.id, sLabel, milestone.number),
								type: "status_override",
								from: slice.status,
								to: "closed",
								reason: "milestone-close",
							});
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
		"PR.md",
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
		// Fetch and fast-forward the local milestone branch to avoid divergence
		// errors on push. If the branches have diverged (non-ff), bail with a
		// clear error rather than auto-resolving — conflicts must be fixed manually.
		execFileSync("git", ["fetch", "origin", milestone.branch], {
			cwd: root,
			encoding: "utf-8",
			env,
		});
		try {
			execFileSync("git", ["merge", "--ff-only", `origin/${milestone.branch}`], {
				cwd: root,
				encoding: "utf-8",
				env,
			});
		} catch {
			return {
				success: false,
				error: `Local ${milestone.branch} has diverged from origin. Run 'git pull --rebase' manually to resolve before re-running /tff complete-milestone.`,
			};
		}

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
		db.transaction(() => {
			projectCommand(db, root, "complete-milestone-changes", { milestoneId });
			const { hash, row } = appendCommand(root, "complete-milestone-changes", { milestoneId });
			updateLogCursor(db, hash, row);
		})();

		// Hand off to the agent: ask the user whether the milestone PR was merged.
		// Mirrors the slice-ship flow at src/phases/ship.ts.
		pi.sendUserMessage(
			[
				`Milestone ${mLabel} PR is open: ${prUrl}`,
				"",
				"Now ask the user whether the PR was merged, using tff_ask_user with id",
				`\`milestone_gate_${mLabel}\`, header "Milestone PR status", and two options:`,
				'  1) label "PR merged"        — description "I merged the PR on GitHub."',
				'  2) label "PR needs changes" — description "Reviewers requested changes."',
				"",
				"After the user replies:",
				`  - If "PR merged": call tff_complete_milestone_merged({ milestoneLabel: "${mLabel}" }).`,
				`  - If "PR needs changes": ask for the feedback text in one follow-up message, then call`,
				`    tff_complete_milestone_changes({ milestoneLabel: "${mLabel}", feedback: "<their exact feedback>" }).`,
				"",
				"Do NOT call these tools before the user has explicitly answered. Do NOT poll GitHub — the user's reply is the source of truth.",
			].join("\n"),
		);

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
	const projectCtx = requireProject(ctx, uiCtx);
	if (!projectCtx) return;
	const { db: database, root, settings: currentSettings } = projectCtx;
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
	const result = await handleCompleteMilestone(database, root, milestone.id, currentSettings, pi);
	if (!result.success) {
		pi.sendUserMessage(`Cannot complete milestone: ${result.error}`);
	}
	// Success path: handleCompleteMilestone already sent the gate-handoff
	// message; a second sendUserMessage here would land while that turn is
	// still processing and trip PI's "Agent is already processing" guard.
}
