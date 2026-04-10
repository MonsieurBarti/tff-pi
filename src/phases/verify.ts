import { readArtifact, writeArtifact } from "../common/artifacts.js";
import { resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";

export const verifyPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "verifying");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
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
			? "\n\nWrite VERIFICATION.md in compressed R1-R10 notation. Preserve: code blocks, file paths, AC checkboxes."
			: "";

		const prompt = {
			systemPrompt: `You are a verifier agent for slice ${sLabel}. Verify acceptance criteria and run tests.${compressHint}`,
			userPrompt: [
				"## SPEC.md (Acceptance Criteria)",
				specMd,
				"",
				"## PLAN.md",
				planMd,
				"",
				"## Test Instructions",
				testInstruction,
				"",
				"## Instructions",
				"1. Check each AC from SPEC.md against the implementation",
				"2. Run scoped tests for changed files",
				"3. Return structured JSON verdict with acResults and testResults",
			].join("\n"),
			tools: [],
			label: `verifier:${sLabel}`,
		};

		const result = await dispatchSubAgent(pi, "verifier", prompt, wtPath);

		if (!result.success) {
			updateSliceStatus(db, slice.id, "executing");
			resetTasksToOpen(db, slice.id);
			return {
				success: false,
				retry: true,
				error: "Verification failed",
				feedback: result.output,
			};
		}

		const compressed = settings.compress.user_artifacts;
		let verificationContent: string;
		try {
			const verdict = JSON.parse(result.output);
			const acLines = (verdict.acResults ?? [])
				.map(
					(ac: { ac: string; status: string; explanation: string }) =>
						`| ${ac.ac} | ${ac.status} | ${ac.explanation} |`,
				)
				.join("\n");
			const testSummary = verdict.testResults
				? `Passed: ${verdict.testResults.passed}, Failed: ${verdict.testResults.failed}, Skipped: ${verdict.testResults.skipped}`
				: "No test results";

			verificationContent = [
				compressed ? "# Verification" : "# Verification Results",
				"",
				compressed ? "## AC" : "## Acceptance Criteria",
				"",
				"| AC | Status | Explanation |",
				"|---|---|---|",
				acLines,
				"",
				compressed ? "## Tests" : "## Test Results",
				"",
				testSummary,
			].join("\n");

			const hasFailed = (verdict.acResults ?? []).some(
				(ac: { status: string }) => ac.status === "FAIL",
			);
			const testsFailed = verdict.testResults?.failed > 0;

			if (hasFailed || testsFailed) {
				writeArtifact(
					root,
					`milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`,
					verificationContent,
				);
				updateSliceStatus(db, slice.id, "executing");
				resetTasksToOpen(db, slice.id);
				return {
					success: false,
					retry: true,
					error: "Verification found failures",
					feedback: verificationContent,
				};
			}
		} catch {
			verificationContent = ["# Verification Results", "", result.output].join("\n");
		}

		writeArtifact(
			root,
			`milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`,
			verificationContent,
		);
		return { success: true, retry: false };
	},
};
