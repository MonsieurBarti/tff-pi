import { readArtifact } from "../common/artifacts.js";
import { resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";

interface ReviewVerdict {
	verdict: "approved" | "denied";
	summary: string;
	findings: Array<{ file: string; message: string }>;
	tasksToRework?: string[];
}

function parseVerdict(output: string): ReviewVerdict {
	try {
		return JSON.parse(output) as ReviewVerdict;
	} catch {
		return { verdict: "denied", summary: output, findings: [] };
	}
}

export const reviewPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, root, slice, milestoneNumber, settings } = ctx;
		updateSliceStatus(db, slice.id, "reviewing");

		const mLabel = milestoneLabel(milestoneNumber);
		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const wtPath = getWorktreePath(root, sLabel);

		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
		const verifyMd =
			readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`) ?? "";

		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite all feedback in compressed R1-R10 notation. Preserve: code blocks, file paths."
			: "";

		const sharedContext = [
			"## SPEC.md",
			specMd,
			"",
			"## PLAN.md",
			planMd,
			"",
			"## VERIFICATION.md",
			verifyMd,
		].join("\n");

		const codeReviewPrompt = {
			systemPrompt: `You are a code reviewer agent. Review for quality, spec alignment, and correctness.${compressHint}`,
			userPrompt: `${sharedContext}\n\nReview the code changes and return a JSON verdict.`,
			tools: [],
			label: `code-reviewer:${sLabel}`,
		};

		const securityReviewPrompt = {
			systemPrompt: `You are a security reviewer agent. Review for OWASP top 10 vulnerabilities.${compressHint}`,
			userPrompt: `${sharedContext}\n\nReview the code changes for security issues and return a JSON verdict.`,
			tools: [],
			label: `security-reviewer:${sLabel}`,
		};

		const [codeResult, securityResult] = await Promise.allSettled([
			dispatchSubAgent(pi, "code-reviewer", codeReviewPrompt, wtPath),
			dispatchSubAgent(pi, "security-reviewer", securityReviewPrompt, wtPath),
		]);

		const codeOutput =
			codeResult.status === "fulfilled"
				? codeResult.value
				: { success: false, output: "Code review failed to dispatch" };
		const securityOutput =
			securityResult.status === "fulfilled"
				? securityResult.value
				: { success: false, output: "Security review failed to dispatch" };

		if (!codeOutput.success || !securityOutput.success) {
			updateSliceStatus(db, slice.id, "executing");
			resetTasksToOpen(db, slice.id);
			return {
				success: false,
				retry: true,
				error: "Review agent dispatch failed",
				feedback: [codeOutput.output, securityOutput.output].join("\n"),
			};
		}

		const codeVerdict = parseVerdict(codeOutput.output);
		const securityVerdict = parseVerdict(securityOutput.output);

		if (codeVerdict.verdict === "denied" || securityVerdict.verdict === "denied") {
			updateSliceStatus(db, slice.id, "executing");
			resetTasksToOpen(db, slice.id);
			const feedback = [
				codeVerdict.verdict === "denied" ? `Code review: ${codeVerdict.summary}` : "",
				securityVerdict.verdict === "denied" ? `Security review: ${securityVerdict.summary}` : "",
			]
				.filter(Boolean)
				.join("\n");
			return {
				success: false,
				retry: true,
				error: "Review denied",
				feedback,
			};
		}

		return { success: true, retry: false };
	},
};
