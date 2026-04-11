import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { readArtifact, writeArtifact } from "../common/artifacts.js";
import {
	getMilestone,
	getSlices,
	resetTasksToOpen,
	updateMilestoneStatus,
	updateSlicePrUrl,
	updateSliceStatus,
} from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getDefaultBranch, gitEnv } from "../common/git.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import type { Settings } from "../common/settings.js";
import { type Slice, milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath, removeWorktree } from "../common/worktree.js";

export interface PreflightResult {
	ok: boolean;
	errors: string[];
}

export function preflightCheck(
	root: string,
	slice: Slice,
	milestoneNumber: number,
): PreflightResult {
	const errors: string[] = [];
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);
	const base = `milestones/${mLabel}/slices/${sLabel}`;

	// Check required artifacts exist and are non-empty
	const requiredArtifacts = [
		"SPEC.md",
		"PLAN.md",
		"REQUIREMENTS.md",
		"VERIFICATION.md",
		"REVIEW.md",
	];
	for (const artifact of requiredArtifacts) {
		const content = readArtifact(root, `${base}/${artifact}`);
		if (!content || content.trim().length === 0) {
			errors.push(`${artifact} missing`);
		}
	}

	// Check verification cleanliness
	const verification = readArtifact(root, `${base}/VERIFICATION.md`) ?? "";
	const uncheckedItems = verification.match(/^- \[ \]/gm);
	if (uncheckedItems && uncheckedItems.length > 0) {
		errors.push(`VERIFICATION.md has ${uncheckedItems.length} unchecked item(s)`);
	}
	if (/\bFAIL\b/i.test(verification) || /\bBLOCKED\b/i.test(verification)) {
		errors.push("VERIFICATION.md contains failure marker (FAIL or BLOCKED)");
	}

	return { ok: errors.length === 0, errors };
}

export const shipPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "shipping");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const wtPath = getWorktreePath(root, sLabel);
		const milestoneBranch = `milestone/${mLabel}`;
		const sliceBranch = `slice/${sLabel}`;
		const env = gitEnv();

		const startTime = Date.now();
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "ship",
		});

		try {
			// Push slice branch
			execFileSync("git", ["push", "-u", "origin", sliceBranch], {
				cwd: wtPath,
				encoding: "utf-8",
				env,
			});

			// Build PR body
			const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
			const verifyMd =
				readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`) ?? "";
			const prBody = [
				`## ${sLabel}: ${slice.title}`,
				"",
				"### Acceptance Criteria",
				specMd,
				"",
				"### Verification",
				verifyMd,
			].join("\n");

			// Create PR
			const prUrl = execFileSync(
				"gh",
				[
					"pr",
					"create",
					"--base",
					milestoneBranch,
					"--head",
					sliceBranch,
					"--title",
					`feat(${sLabel}): ${slice.title}`,
					"--body",
					prBody,
				],
				{ cwd: wtPath, encoding: "utf-8", env },
			).trim();

			// Store PR URL
			updateSlicePrUrl(db, slice.id, prUrl);

			// Extract PR number from URL
			const prNumber = prUrl.split("/").pop() ?? "";

			// Write PR.md — respect user_artifacts compression
			const compressed = settings.compress.user_artifacts;
			const prMd = compressed
				? [`# PR: ${sLabel}`, `URL: ${prUrl} | Base: ${milestoneBranch}`, prBody].join("\n")
				: [
						"# Pull Request",
						"",
						`**URL:** ${prUrl}`,
						"",
						`**Title:** feat(${sLabel}): ${slice.title}`,
						"",
						`**Base:** ${milestoneBranch}`,
						"",
						"## Description",
						prBody,
					].join("\n");
			writeArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PR.md`, prMd);

			// Wait for CI
			try {
				execFileSync("gh", ["pr", "checks", prNumber, "--watch"], {
					cwd: wtPath,
					encoding: "utf-8",
					env,
					timeout: 600_000,
				});
			} catch {
				// CI failed — loop back to executing for fixes
				updateSliceStatus(db, slice.id, "executing");
				resetTasksToOpen(db, slice.id);
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "ship",
					durationMs: Date.now() - startTime,
					error: "CI checks failed",
				});
				return { success: false, retry: true, error: "CI checks failed" };
			}

			// Squash merge
			execFileSync("gh", ["pr", "merge", prNumber, "--squash"], {
				cwd: wtPath,
				encoding: "utf-8",
				env,
			});

			// Cleanup worktree
			removeWorktree(root, sLabel);

			// Pull milestone branch — stash any uncommitted work first
			try {
				const status = execFileSync("git", ["status", "--porcelain"], {
					cwd: root,
					encoding: "utf-8",
					env,
				}).trim();
				if (status) {
					execFileSync("git", ["stash", "push", "-m", `tff-ship-${sLabel}`], {
						cwd: root,
						encoding: "utf-8",
						env,
					});
				}
			} catch {
				// Ignore stash errors
			}
			execFileSync("git", ["checkout", milestoneBranch], {
				cwd: root,
				encoding: "utf-8",
				env,
			});
			execFileSync("git", ["pull", "origin", milestoneBranch], {
				cwd: root,
				encoding: "utf-8",
				env,
			});

			// Mark slice closed
			updateSliceStatus(db, slice.id, "closed");

			// Check if all slices in milestone are done
			checkMilestoneCompletion(db, root, slice.milestoneId, settings);

			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_complete",
				phase: "ship",
				durationMs: Date.now() - startTime,
			});
			return { success: true, retry: false };
		} catch (err) {
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "ship",
				durationMs: Date.now() - startTime,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				success: false,
				retry: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
};

// Milestone completion — called after slice is closed
export function checkMilestoneCompletion(
	db: Database.Database,
	root: string,
	milestoneId: string,
	settings: Settings,
): void {
	const slices = getSlices(db, milestoneId);
	const allClosed = slices.length > 0 && slices.every((s) => s.status === "closed");
	if (!allClosed) return;

	const milestone = getMilestone(db, milestoneId);
	if (!milestone || milestone.status === "completing" || milestone.status === "closed") return;

	updateMilestoneStatus(db, milestoneId, "completing");

	const targetBranch = settings.milestone_target_branch ?? getDefaultBranch(root) ?? "main";
	const prBody = slices
		.map(
			(s) =>
				`- ${sliceLabel(milestone.number, s.number)}: ${s.title}${s.prUrl ? ` (${s.prUrl})` : ""}`,
		)
		.join("\n");

	const env = gitEnv();
	try {
		execFileSync(
			"gh",
			[
				"pr",
				"create",
				"--base",
				targetBranch,
				"--head",
				milestone.branch,
				"--title",
				`milestone(${milestoneLabel(milestone.number)}): ${milestone.name}`,
				"--body",
				`## Milestone: ${milestone.name}\n\n### Slices\n${prBody}`,
			],
			{ cwd: root, encoding: "utf-8", env },
		);
	} catch {
		// gh may fail if PR already exists
	}
}
