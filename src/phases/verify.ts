import { readArtifact, writeArtifact } from "../common/artifacts.js";
import { createCheckpoint } from "../common/checkpoint.js";
import { resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getDiff } from "../common/git.js";
import {
	formatMechanicalReport,
	runMechanicalVerification,
} from "../common/mechanical-verifier.js";
import type { PhaseContext, PhaseModule, PhasePrepareResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { detectVerifyCommands } from "../common/verify-commands.js";
import { getWorktreePath } from "../common/worktree.js";
import { loadPhaseResources } from "../orchestrator.js";

export const verifyPhase: PhaseModule = {
	async prepare(ctx: PhaseContext): Promise<PhasePrepareResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "verifying");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "verify",
		});

		const wtPath = getWorktreePath(root, sLabel);
		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";

		let testInstruction: string;
		if (settings.test_command === "disabled") {
			testInstruction = "Test execution is disabled. Skip the test stage.";
		} else if (settings.test_command) {
			testInstruction = `Run tests with: ${settings.test_command}`;
		} else {
			testInstruction =
				"Auto-discover the test command from project files (package.json, Makefile, etc.). Run scoped tests for changed files where possible.";
		}

		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite VERIFICATION.md in compressed R1-R10 notation."
			: "";

		const { agentPrompt, protocol } = loadPhaseResources("verify");
		const milestoneBranch = `milestone/${mLabel}`;
		const rawDiff = getDiff(milestoneBranch, wtPath) ?? "";
		const diffLines = rawDiff.split("\n");
		const MAX_DIFF_LINES = 800;
		const diff =
			diffLines.length > MAX_DIFF_LINES
				? `${diffLines.slice(0, MAX_DIFF_LINES).join("\n")}\n\n[... ${diffLines.length - MAX_DIFF_LINES} more lines truncated; inspect the worktree directly for full diff ...]`
				: rawDiff;

		const message = [
			agentPrompt,
			protocol,
			"",
			"---",
			"",
			`## Slice: ${sLabel}`,
			`Working directory: ${wtPath}`,
			"",
			"## SPEC.md (Acceptance Criteria)",
			specMd,
			"",
			"## PLAN.md",
			planMd,
			"",
			"## Diff from milestone branch",
			"```diff",
			diff,
			"```",
			"",
			"## Test Instructions",
			testInstruction,
			compressHint,
		].join("\n");

		// --- Mechanical verification (runs independently of AI) ---
		const verifyCommands = detectVerifyCommands(root, settings);
		if (verifyCommands.length > 0) {
			const report = await runMechanicalVerification(verifyCommands, wtPath);
			const reportMd = formatMechanicalReport(report);
			writeArtifact(
				root,
				`milestones/${mLabel}/slices/${sLabel}/VERIFICATION-MECHANICAL.md`,
				reportMd,
			);

			if (!report.allPassed) {
				const failures = report.commands
					.filter((c) => !c.passed)
					.map(
						(c) =>
							`- ${c.name}: exit ${c.exitCode}${c.stderr ? `\n  ${c.stderr.split("\n")[0]}` : ""}`,
					)
					.join("\n");

				// Roll back status so /tff next routes back to execute for retry
				updateSliceStatus(db, slice.id, "executing");
				resetTasksToOpen(db, slice.id);

				pi.events.emit("tff:phase", {
					...makeBaseEvent(slice.id, sLabel, milestoneNumber),
					type: "phase_failed",
					phase: "verify",
					error: "Mechanical verification failed",
				});

				return {
					success: false,
					retry: true,
					feedback: `Mechanical verification found failures:\n${failures}\n\nFull report written to VERIFICATION-MECHANICAL.md. Run \`/tff next\` to route back to execute and fix.`,
				};
			}
		}

		// Post-verify checkpoint
		createCheckpoint(wtPath, sLabel, "post-verify");

		return { success: true, retry: false, message };
	},
};
