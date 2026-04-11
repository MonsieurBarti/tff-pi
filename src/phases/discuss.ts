import { readArtifact } from "../common/artifacts.js";
import { getSlice, updateSliceStatus } from "../common/db.js";
import { resetGates } from "../common/discuss-gates.js";
import { dispatchSubAgent } from "../common/dispatch.js";
import { makeBaseEvent } from "../common/events.js";
import type { PhaseContext, PhaseModule, PhaseResult } from "../common/phase.js";
import { requestReview } from "../common/plannotator-review.js";
import { type PreparationBrief, buildPreparationBrief } from "../common/preparation.js";
import { nextSliceStatus } from "../common/state-machine.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import {
	buildPhasePrompt,
	collectPhaseContext,
	loadPhaseResources,
	verifyPhaseArtifacts,
} from "../orchestrator.js";

const MAX_RETRIES = 2;

export const discussPhase: PhaseModule = {
	async run(ctx: PhaseContext): Promise<PhaseResult> {
		const { pi, db, slice, milestoneNumber } = ctx;
		const headless = ctx.headless ?? false;

		updateSliceStatus(db, slice.id, "discussing");
		resetGates(slice.id);

		const sLabel = sliceLabel(milestoneNumber, slice.number);
		const startTime = Date.now();

		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_start",
			phase: "discuss",
		});

		// Build preparation brief (shared by both paths)
		const brief = await buildPreparationBrief(ctx.root, db, slice, milestoneNumber);

		if (!headless) {
			return runInteractive(ctx, brief, startTime);
		}
		return runHeadless(ctx, brief, startTime);
	},
};

async function runInteractive(
	ctx: PhaseContext,
	brief: PreparationBrief,
	startTime: number,
): Promise<PhaseResult> {
	const { pi, slice, milestoneNumber } = ctx;
	const sLabel = sliceLabel(milestoneNumber, slice.number);

	// Load interactive resources
	const { agentPrompt, protocol } = loadPhaseResources("discuss");

	// Build the message to send to PI
	const briefSection = formatBrief(brief);
	const sliceContext = [
		`## Slice: ${sLabel} — "${slice.title}"`,
		`Slice ID: ${slice.id}`,
		`Tier: ${slice.tier ?? "unclassified"}`,
	].join("\n");

	const message = [
		agentPrompt,
		protocol,
		"",
		"---",
		"",
		"## Preparation Brief",
		"",
		briefSection,
		"",
		"---",
		"",
		sliceContext,
	].join("\n");

	// Send to main session — PI becomes the brainstormer
	pi.sendUserMessage(message);

	// Interactive mode: phase completes immediately.
	// Artifacts are verified on next /tff next call.
	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestoneNumber),
		type: "phase_complete",
		phase: "discuss",
		durationMs: Date.now() - startTime,
	});

	return { success: true, retry: false };
}

async function runHeadless(
	ctx: PhaseContext,
	brief: PreparationBrief,
	startTime: number,
): Promise<PhaseResult> {
	const { pi, db, root, slice, milestoneNumber, settings } = ctx;
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);

	// Build headless prompt with preparation brief inlined
	const context = collectPhaseContext(root, slice, milestoneNumber, "discuss");
	context.PREPARATION_BRIEF = formatBrief(brief);

	const prompt = buildPhasePrompt(
		slice,
		milestoneNumber,
		"discuss",
		context,
		settings.compress.user_artifacts,
	);

	// First attempt
	let lastOutput = "";
	const agentResult = await dispatchSubAgent(
		pi,
		"brainstormer-headless",
		prompt,
		root,
		ctx.onSubAgentActivity,
	);

	if (!agentResult.success) {
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_failed",
			phase: "discuss",
			durationMs: Date.now() - startTime,
			error: agentResult.output,
		});
		return { success: false, retry: false, error: agentResult.output };
	}
	lastOutput = agentResult.output;

	// Verify artifacts
	const verification = verifyPhaseArtifacts(db, root, slice, milestoneNumber, "discuss");
	if (!verification.ok) {
		const error = `Phase artifacts missing: ${verification.missing.join(", ")}. Sub-agent output: ${lastOutput.substring(0, 500)}`;
		pi.events.emit("tff:phase", {
			...makeBaseEvent(slice.id, sLabel, milestoneNumber),
			type: "phase_failed",
			phase: "discuss",
			durationMs: Date.now() - startTime,
			error,
		});
		return { success: false, retry: false, error };
	}

	// Plannotator gate with feedback-enriched retries
	const artifactPath = `milestones/${mLabel}/slices/${sLabel}/SPEC.md`;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const content = readArtifact(root, artifactPath) ?? "";
		const gateResult = await requestReview(pi, artifactPath, content, "spec");

		if (gateResult.approved) {
			const current = getSlice(db, slice.id);
			if (current) {
				const next = nextSliceStatus(current.status, current.tier ?? undefined);
				if (next) updateSliceStatus(db, slice.id, next);
			}
			const refreshed = getSlice(db, slice.id);
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_complete",
				phase: "discuss",
				durationMs: Date.now() - startTime,
				...(refreshed?.tier ? { tier: refreshed.tier } : {}),
			});
			return { success: true, retry: false };
		}

		if (attempt < MAX_RETRIES) {
			pi.events.emit("tff:phase", {
				...makeBaseEvent(slice.id, sLabel, milestoneNumber),
				type: "phase_retried",
				phase: "discuss",
				durationMs: Date.now() - startTime,
				feedback: gateResult.feedback ?? "Gate denied",
			});

			// Feedback-enriched retry: include prior spec + feedback
			const retryContext = { ...context };
			retryContext.PRIOR_SPEC = content;
			retryContext.GATE_FEEDBACK = gateResult.feedback ?? "Spec was denied by reviewer.";

			const retryPrompt = buildPhasePrompt(
				slice,
				milestoneNumber,
				"discuss",
				retryContext,
				settings.compress.user_artifacts,
			);

			const retryResult = await dispatchSubAgent(
				pi,
				"brainstormer-headless",
				retryPrompt,
				root,
				ctx.onSubAgentActivity,
			);
			if (!retryResult.success) break;
			lastOutput = retryResult.output;
		}
	}

	pi.events.emit("tff:phase", {
		...makeBaseEvent(slice.id, sLabel, milestoneNumber),
		type: "phase_failed",
		phase: "discuss",
		durationMs: Date.now() - startTime,
		error: "Gate denied after retries",
	});
	return { success: false, retry: false, error: "Gate denied after retries" };
}

function formatBrief(brief: PreparationBrief): string {
	const sections: string[] = [];

	if (brief.codebaseBrief) {
		sections.push(`### Codebase\n\n${brief.codebaseBrief}`);
	}
	if (brief.artifacts.project) {
		sections.push(`### PROJECT.md\n\n${brief.artifacts.project}`);
	}
	if (brief.artifacts.requirements) {
		sections.push(`### REQUIREMENTS.md\n\n${brief.artifacts.requirements}`);
	}
	if (brief.priorContext) {
		sections.push(`### Prior Context\n\n${brief.priorContext}`);
	}
	for (let i = 0; i < brief.artifacts.completedSpecs.length; i++) {
		sections.push(`### Completed Slice ${i + 1} Spec\n\n${brief.artifacts.completedSpecs[i]}`);
	}
	if (brief.relatedFiles) {
		sections.push(`### Related Files\n\n${brief.relatedFiles}`);
	}

	return sections.join("\n\n");
}
