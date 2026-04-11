import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifact } from "../common/artifacts.js";

const RESOURCES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "resources");

function loadResource(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}
import { getTasks, resetTasksToOpen, updateSliceStatus } from "../common/db.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import { makeBaseEvent } from "../common/events.js";
import { discoverFffService } from "../common/fff-integration.js";
import { getDiff } from "../common/git.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { getWorktreePath } from "../common/worktree.js";
import { enrichContextWithFff } from "../orchestrator.js";

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
		const startTime = Date.now();
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "review",
		});

		const wtPath = getWorktreePath(root, sLabel);

		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`) ?? "";
		const planMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`) ?? "";
		const verifyMd =
			readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`) ?? "";

		const compressHint = settings.compress.user_artifacts
			? "\n\nWrite all feedback in compressed R1-R10 notation. Preserve: code blocks, file paths."
			: "";

		const codeReviewerAgent = loadResource(join(RESOURCES_DIR, "agents", "code-reviewer.md"));
		const securityReviewerAgent = loadResource(
			join(RESOURCES_DIR, "agents", "security-reviewer.md"),
		);
		const reviewProtocol = loadResource(join(RESOURCES_DIR, "protocols", "reviewing.md"));

		const milestoneBranch = `milestone/${mLabel}`;
		const diff = getDiff(milestoneBranch, wtPath) ?? "";

		let sharedContext = [
			`## Slice: ${sLabel}`,
			"",
			"## SPEC.md",
			specMd,
			"",
			"## PLAN.md",
			planMd,
			"",
			"## VERIFICATION.md",
			verifyMd,
			"",
			"## Diff from milestone branch",
			"```diff",
			diff,
			"```",
		].join("\n");

		const fffBridge = discoverFffService(pi);
		if (fffBridge) {
			const tasks = getTasks(db, slice.id);
			const extraCtx: Record<string, string> = {};
			await enrichContextWithFff(extraCtx, tasks, fffBridge);
			if (extraCtx.RELATED_FILES) {
				sharedContext += `\n\n## Related Files\n${extraCtx.RELATED_FILES}`;
			}
		}

		const codeReviewPrompt = {
			systemPrompt: [codeReviewerAgent, reviewProtocol, compressHint].filter(Boolean).join("\n\n"),
			userPrompt: `${sharedContext}\n\nReview the code changes and return a JSON verdict.`,
			tools: [],
			label: `code-reviewer:${sLabel}`,
		};

		const securityReviewPrompt = {
			systemPrompt: [securityReviewerAgent, reviewProtocol, compressHint]
				.filter(Boolean)
				.join("\n\n"),
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
			const errorMsg = "Review agent dispatch failed";
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "review",
				durationMs: Date.now() - startTime,
				error: errorMsg,
			});
			return {
				success: false,
				retry: true,
				error: errorMsg,
				feedback: [codeOutput.output, securityOutput.output].join("\n"),
			};
		}

		const codeVerdict = parseVerdict(codeOutput.output);
		const securityVerdict = parseVerdict(securityOutput.output);

		pi.events.emit("tff:review", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "review_verdict",
			reviewer: "code",
			verdict: codeVerdict.verdict,
			findingCount: codeVerdict.findings.length,
			summary: codeVerdict.summary,
			tasksToRework: codeVerdict.tasksToRework,
		});
		pi.events.emit("tff:review", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "review_verdict",
			reviewer: "security",
			verdict: securityVerdict.verdict,
			findingCount: securityVerdict.findings.length,
			summary: securityVerdict.summary,
			tasksToRework: securityVerdict.tasksToRework,
		});

		if (codeVerdict.verdict === "denied" || securityVerdict.verdict === "denied") {
			updateSliceStatus(db, slice.id, "executing");
			resetTasksToOpen(db, slice.id);
			const feedback = [
				codeVerdict.verdict === "denied" ? `Code review: ${codeVerdict.summary}` : "",
				securityVerdict.verdict === "denied" ? `Security review: ${securityVerdict.summary}` : "",
			]
				.filter(Boolean)
				.join("\n");
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_failed",
				phase: "review",
				durationMs: Date.now() - startTime,
				error: "Review denied",
				feedback,
			});
			return {
				success: false,
				retry: true,
				error: "Review denied",
				feedback,
			};
		}

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_complete",
			phase: "review",
			durationMs: Date.now() - startTime,
		});
		return { success: true, retry: false };
	},
};
