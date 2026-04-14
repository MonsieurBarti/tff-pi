import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { readArtifact, writeArtifact } from "../common/artifacts.js";
import { cleanupCheckpoints } from "../common/checkpoint.js";
import { compressIfEnabled } from "../common/compress.js";
import { getSlices, resetTasksToOpen, updateSlicePrUrl } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getPrTools } from "../common/gh-client.js";
import { parsePrUrl } from "../common/gh-helpers.js";
import { branchExists, gitEnv, remoteBranchExists } from "../common/git.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import type { Slice } from "../common/types.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath, removeWorktree } from "../common/worktree.js";
import { predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

export interface PreflightResult {
	ok: boolean;
	errors: string[];
}

/**
 * Cleanup after a slice PR is merged: remove worktree + checkpoints, delete
 * slice branch (local + remote), checkout the milestone branch and pull,
 * mark the slice closed. Shared between the `shipPhase` re-entry path and the
 * new `/tff ship-merged` slash command (user-attested merge, no PR fetch).
 */
export function finalizeMergedSlice(
	_db: Database.Database,
	root: string,
	slice: Slice,
	milestoneNumber: number,
): void {
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);
	const milestoneBranch = `milestone/${mLabel}`;
	const sliceBranch = `slice/${sLabel}`;
	const env = gitEnv();

	cleanupCheckpoints(root, sLabel);
	removeWorktree(root, sLabel);

	// Stash any uncommitted work before swapping branches.
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

	// Delete slice branches — local and remote. Check existence first rather
	// than swallowing errors: GitHub's squash-merge often deletes the remote
	// branch automatically, and the local branch may already be gone.
	if (branchExists(sliceBranch, root)) {
		execFileSync("git", ["branch", "-D", sliceBranch], {
			cwd: root,
			encoding: "utf-8",
			env,
		});
	}
	if (remoteBranchExists(sliceBranch, root)) {
		execFileSync("git", ["push", "origin", "--delete", sliceBranch], {
			cwd: root,
			encoding: "utf-8",
			env,
		});
	}
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

	// All tiers must have all artifacts — review is required for every slice.
	const requiredArtifacts = [
		"SPEC.md",
		"PLAN.md",
		"REQUIREMENTS.md",
		"VERIFICATION.md",
		"REVIEW.md",
		"PR.md",
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
	// Match FAIL/BLOCKED only as shouty-case verdict markers — lowercase
	// mentions ("0 fail", "would fail if...") are narrative text, not status.
	if (/\bFAIL\b/.test(verification) || /\bBLOCKED\b/.test(verification)) {
		errors.push("VERIFICATION.md contains failure marker (FAIL or BLOCKED)");
	}

	return { ok: errors.length === 0, errors };
}

function buildPrBody(root: string, mLabel: string, sLabel: string): string {
	const prMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PR.md`);
	if (!prMd || prMd.trim().length === 0) {
		throw new Error(
			`PR.md missing for ${sLabel}. Run the verify phase to author it via tff_write_pr before shipping.`,
		);
	}
	return prMd;
}

export function suggestNextAction(db: Database.Database, milestoneId: string): string {
	const slices = getSlices(db, milestoneId);
	const openSlices = slices.filter((s) => s.status !== "closed");
	if (openSlices.length === 0) {
		return "All slices closed. Run `/tff complete-milestone` to create the milestone PR.";
	}
	return `${openSlices.length} slice(s) remaining. Run \`/tff discuss\` to start the next slice or \`/tff next\` to advance.`;
}

export const shipPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
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
				const parsed = parsePrUrl(slice.prUrl);
				if (!parsed) {
					return { success: false, retry: false, error: `Invalid PR URL: ${slice.prUrl}` };
				}
				const prTools = getPrTools();
				const viewResult = await prTools.view({ repo: parsed.repo, number: parsed.number });
				if (viewResult.code !== 0) {
					return {
						success: false,
						retry: false,
						error: `gh pr view failed: ${viewResult.stderr}`,
					};
				}
				const pr = JSON.parse(viewResult.stdout) as {
					state: string;
					comments: { body: string; author: { login: string } }[];
				};

				if (pr.state === "MERGED") {
					finalizeMergedSlice(db, root, slice, milestoneNumber);
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
					// Stash feedback as an artifact; leave the slice in `shipping`
					// so the user can decide whether to do a small fix (edit
					// worktree + ship-merged) or re-enter execute. The execute
					// phase picks up REVIEW_FEEDBACK.md on next run.
					// phase_retried maps to `shipping` via reconciler rule 2 (ship/retried → shipping).
					writeArtifact(
						root,
						`milestones/${mLabel}/slices/${sLabel}/REVIEW_FEEDBACK.md`,
						`# Review Feedback\n\n${feedback}\n`,
					);
					pi.events.emit("tff:phase", {
						...makeBaseEvent(slice.id, sLabel, milestoneNumber),
						type: "phase_retried",
						phase: "ship",
						durationMs: Date.now() - startTime,
						error: "PR has review comments",
					});
					pi.sendUserMessage(
						[
							`Review feedback recorded for ${sLabel}.`,
							"",
							"Reviewer said:",
							`> ${feedback}`,
							"",
							`For small fixes: edit the worktree, push to the slice branch, then run \`/tff ship-merged ${sLabel}\` once merged.`,
							"",
							`For larger fixes: run \`/tff execute ${sLabel}\` to re-enter the TDD loop (tasks will be reset automatically).`,
						].join("\n"),
					);
					return { success: true, retry: false };
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

			// Ensure the milestone branch is on origin before pushing the slice
			// branch — `gh pr create` needs the base ref to exist remotely, and
			// older projects may have created the milestone branch locally
			// without ever pushing it. Idempotent: if origin already has it,
			// `push -u` is a no-op.
			execFileSync("git", ["push", "-u", "origin", milestoneBranch], {
				cwd: wtPath,
				encoding: "utf-8",
				env,
			});

			// Push slice branch
			execFileSync("git", ["push", "-u", "origin", sliceBranch], {
				cwd: wtPath,
				encoding: "utf-8",
				env,
			});

			// Build PR body — author wrote PR.md during verify
			const prBody = buildPrBody(root, mLabel, sLabel);

			// Derive repo slug from origin remote (gh-pi requires explicit repo)
			const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
				cwd: wtPath,
				encoding: "utf-8",
				env,
			}).trim();
			const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
			if (!repoMatch || !repoMatch[1]) {
				return {
					success: false,
					retry: false,
					error: `Cannot parse repo from remote: ${remoteUrl}`,
				};
			}
			const repo = repoMatch[1];

			// Create PR
			const prTools = getPrTools();
			const createResult = await prTools.create({
				repo,
				title: `feat(${sLabel}): ${slice.title}`,
				body: prBody,
				head: sliceBranch,
				base: milestoneBranch,
			});
			if (createResult.code !== 0) {
				return {
					success: false,
					retry: false,
					error: `gh pr create failed: ${createResult.stderr}`,
				};
			}
			const prUrl = createResult.stdout.trim();

			// Store PR URL
			updateSlicePrUrl(db, slice.id, prUrl);

			// Extract PR number from URL
			const prNumber = Number.parseInt(prUrl.split("/").pop() ?? "0", 10);

			// Prepend PR metadata to the existing PR.md (body authored in verify)
			const compressed = settings.compress.user_artifacts;
			const header = compressed
				? `# PR: ${sLabel}\nURL: ${prUrl} | Base: ${milestoneBranch}\n\n`
				: [
						"# Pull Request",
						"",
						`**URL:** ${prUrl}`,
						`**Base:** ${milestoneBranch}`,
						`**Title:** feat(${sLabel}): ${slice.title}`,
						"",
						"---",
						"",
						"",
					].join("\n");
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/PR.md`,
				compressIfEnabled(header + prBody, "artifacts", settings),
			);

			// Wait for CI. Treat "no checks configured" as green — repos without
			// a CI workflow have nothing to fail on, and we don't want to
			// punish users for not wiring up GitHub Actions.
			const checksResult = await prTools.checks({ repo, number: prNumber, watch: true });
			const noChecksConfigured =
				checksResult.code !== 0 &&
				/no checks? (?:reported|found)/i.test(
					`${checksResult.stderr ?? ""}\n${checksResult.stdout ?? ""}`,
				);
			if (checksResult.code !== 0 && !noChecksConfigured) {
				// CI failed — reconciler rule 3 (ship/failed → executing) handles status.
				resetTasksToOpen(db, slice.id);
				const detail = (checksResult.stderr || checksResult.stdout || "").trim();
				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "ship",
					durationMs: Date.now() - startTime,
					error: `CI checks failed: ${detail}`,
				});
				return {
					success: false,
					retry: true,
					error: `CI checks failed: ${detail}`,
				};
			}

			// Ship always uses manual confirm: hand control to the agent to poll
			// the user via tff_ask_user until they report merged/changes. The
			// agent calls tff_ship_merged or tff_ship_changes based on the
			// user's reply — no GitHub polling; the user's answer is the source
			// of truth.
			pi.sendUserMessage(
				[
					`The slice PR is open: ${prUrl}`,
					"",
					`Now ask the user whether the PR was merged, using tff_ask_user with id \`pr_gate_${sLabel}\`, header "PR status", and two options:`,
					'  1) label "PR merged"       — description "I merged the PR on GitHub."',
					'  2) label "PR needs changes" — description "Reviewers requested changes."',
					"",
					"After the user replies:",
					`  - If "PR merged": call tff_ship_merged({ sliceLabel: "${sLabel}" }).`,
					`  - If "PR needs changes": ask the user for the reviewer feedback text in one follow-up message, then call tff_ship_changes({ sliceLabel: "${sLabel}", feedback: "<their exact feedback>" }).`,
					"",
					"Do NOT call these tools before the user has explicitly answered. Do NOT poll GitHub or guess the state — the user's reply is the source of truth.",
				].join("\n"),
			);
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
