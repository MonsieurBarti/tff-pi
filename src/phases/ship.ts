import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { readArtifact, writeArtifact } from "../common/artifacts.js";
import { getSlices, resetTasksToOpen, updateSlicePrUrl, updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { gitEnv } from "../common/git.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import type { Slice } from "../common/types.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath, removeWorktree } from "../common/worktree.js";
import { predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

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

function buildPrBody(root: string, mLabel: string, sLabel: string, sliceTitle: string): string {
	const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
	const verifyMd =
		readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`) ?? "";
	const reviewMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/REVIEW.md`) ?? "";
	return [
		`## ${sLabel}: ${sliceTitle}`,
		"",
		"### Acceptance Criteria",
		specMd,
		"",
		"### Verification",
		verifyMd,
		"",
		"### Review Findings",
		reviewMd,
	].join("\n");
}

function suggestNextAction(db: Database.Database, milestoneId: string): string {
	const slices = getSlices(db, milestoneId);
	const openSlices = slices.filter((s) => s.status !== "closed");
	if (openSlices.length === 0) {
		return "All slices closed. Run `/tff complete-milestone` to create the milestone PR.";
	}
	return `${openSlices.length} slice(s) remaining. Run \`/tff discuss\` to start the next slice or \`/tff next\` to advance.`;
}

export const shipPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;

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

		closePredecessorIfReady(pi, db, root, slice, "ship", predecessorPhase, verifyPhaseArtifacts);

		try {
			// --- Re-entry: PR already exists ---
			if (slice.prUrl) {
				const prJson = execFileSync("gh", ["pr", "view", slice.prUrl, "--json", "state,comments"], {
					cwd: root,
					encoding: "utf-8",
					env,
				}).trim();
				const pr = JSON.parse(prJson) as {
					state: string;
					comments: { body: string; author: { login: string } }[];
				};

				if (pr.state === "MERGED") {
					removeWorktree(root, sLabel);
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
					updateSliceStatus(db, slice.id, "closed");
					const next = suggestNextAction(db, slice.milestoneId);
					pi.sendUserMessage(`PR merged. Slice closed.\n\n${next}`);
					pi.events.emit("tff:phase", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "phase_complete",
						phase: "ship",
						durationMs: Date.now() - startTime,
					});
					return { success: true, retry: false };
				}

				if (pr.comments.length > 0) {
					const feedback = pr.comments.map((c) => `**${c.author.login}**: ${c.body}`).join("\n\n");
					updateSliceStatus(db, slice.id, "executing");
					resetTasksToOpen(db, slice.id);
					pi.events.emit("tff:phase", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "phase_failed",
						phase: "ship",
						durationMs: Date.now() - startTime,
						error: "PR has review comments",
					});
					return { success: false, retry: true, feedback };
				}

				pi.sendUserMessage("PR still waiting for review.");
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_complete",
					phase: "ship",
					durationMs: Date.now() - startTime,
				});
				return { success: true, retry: false };
			}

			// --- First run: no PR yet ---

			// Pre-flight check
			const preflight = preflightCheck(root, slice, milestoneNumber);
			if (!preflight.ok) {
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "ship",
					durationMs: Date.now() - startTime,
					error: "Pre-flight check failed",
				});
				return {
					success: false,
					retry: false,
					error: `Pre-flight failed: ${preflight.errors.join(", ")}`,
				};
			}

			updateSliceStatus(db, slice.id, "shipping");

			// Push slice branch
			execFileSync("git", ["push", "-u", "origin", sliceBranch], {
				cwd: wtPath,
				encoding: "utf-8",
				env,
			});

			// Build PR body
			const prBody = buildPrBody(root, mLabel, sLabel, slice.title);

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

			// Auto-merge disabled: leave PR open for manual review
			if (!settings.ship.auto_merge) {
				pi.sendUserMessage(`PR ready for review at ${prUrl}`);
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_complete",
					phase: "ship",
					durationMs: Date.now() - startTime,
				});
				return { success: true, retry: false };
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

			const next = suggestNextAction(db, slice.milestoneId);
			pi.sendUserMessage(`Slice shipped and merged.\n\n${next}`);

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
