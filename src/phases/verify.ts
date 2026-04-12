import { readArtifact } from "../common/artifacts.js";
import { updateSliceStatus } from "../common/db.js";
import { makeBaseEvent } from "../common/events.js";
import { getDiff } from "../common/git.js";
import { closePredecessorIfReady } from "../common/phase-completion.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import { loadPhaseResources, predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

export const verifyPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "verifying");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "verify",
		});

		closePredecessorIfReady(pi, db, root, slice, "verify", predecessorPhase, verifyPhaseArtifacts);

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
		const diff = getDiff(milestoneBranch, wtPath) ?? "";

		if (diff.trim() === "") {
			const error = `No diff between ${milestoneBranch} and the slice worktree. The execute phase produced no changes — re-run execute before verifying.`;
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "verify",
				error,
			});
			return { success: false, retry: false };
		}

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

		pi.sendUserMessage(message);
		return { success: true, retry: false };
	},
};
