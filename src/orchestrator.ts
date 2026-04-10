import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { readArtifact } from "./common/artifacts.js";
import {
	getActiveMilestone,
	getActiveSlice,
	getProject,
	getSlice,
	updateSliceStatus,
} from "./common/db.js";
import { type SubAgentPrompt, type SubAgentResult, dispatchSubAgent } from "./common/dispatch.js";
import { type ReviewResult, requestReview } from "./common/review.js";
import type { Settings } from "./common/settings.js";
import { nextSliceStatus } from "./common/state-machine.js";
import type { Slice, SliceStatus, Tier } from "./common/types.js";
import { milestoneLabel, sliceLabel } from "./common/types.js";

export type Phase = "discuss" | "research" | "plan";

const RESOURCES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "resources");

export function findActiveSlice(db: Database.Database): Slice | null {
	const project = getProject(db);
	if (!project) return null;
	const milestone = getActiveMilestone(db, project.id);
	if (!milestone) return null;
	return getActiveSlice(db, milestone.id);
}

export function determineNextPhase(status: SliceStatus, tier?: Tier | null): Phase | null {
	switch (status) {
		case "created":
			return "discuss";
		case "discussing":
			return tier === "S" ? "plan" : "research";
		case "researching":
			return "plan";
		default:
			return null;
	}
}

function loadResource(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

const PHASE_AGENT: Record<Phase, string> = {
	discuss: "brainstormer",
	research: "researcher",
	plan: "planner",
};

const PHASE_ENTRY_STATUS: Record<Phase, SliceStatus> = {
	discuss: "discussing",
	research: "researching",
	plan: "planning",
};

const PHASE_TOOLS: Record<Phase, string[]> = {
	discuss: ["tff_classify", "tff_write_spec", "tff_query_state"],
	research: ["tff_write_research", "tff_query_state"],
	plan: ["tff_write_plan", "tff_query_state"],
};

export function collectPhaseContext(
	root: string,
	slice: Slice,
	milestoneNumber: number,
	phase: Phase,
): Record<string, string> {
	const ctx: Record<string, string> = {};
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);

	const projectMd = readArtifact(root, "PROJECT.md");
	if (projectMd) ctx["PROJECT.md"] = projectMd;

	const reqMd = readArtifact(root, `milestones/${mLabel}/REQUIREMENTS.md`);
	if (reqMd) ctx["REQUIREMENTS.md"] = reqMd;

	if (phase === "research" || phase === "plan") {
		const specMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`);
		if (specMd) ctx["SPEC.md"] = specMd;
	}

	if (phase === "plan") {
		const researchMd = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/RESEARCH.md`);
		if (researchMd) ctx["RESEARCH.md"] = researchMd;
	}

	return ctx;
}

export function buildPhasePrompt(
	slice: Slice,
	milestoneNumber: number,
	phase: Phase,
	context: Record<string, string>,
	compressed: boolean,
): SubAgentPrompt {
	const agentName = PHASE_AGENT[phase];
	const agentMd = loadResource(join(RESOURCES_DIR, "agents", `${agentName}.md`));
	const protocolMd = loadResource(join(RESOURCES_DIR, "protocols", `${phase}.md`));

	const sLabel = sliceLabel(milestoneNumber, slice.number);

	let systemPrompt = agentMd;
	if (protocolMd) {
		systemPrompt += `\n\n${protocolMd}`;
	}

	const contextBlock = Object.entries(context)
		.map(([name, content]) => {
			const body = compressed ? content.slice(0, 2000) : content;
			return `### ${name}\n\n${body}`;
		})
		.join("\n\n");

	const userPrompt = [
		`## Slice: ${sLabel} — "${slice.title}"`,
		`Slice ID: ${slice.id}`,
		`Tier: ${slice.tier ?? "unclassified"}`,
		"",
		"## Context",
		"",
		contextBlock,
	].join("\n");

	return {
		systemPrompt,
		userPrompt,
		tools: PHASE_TOOLS[phase],
		label: `${phase}:${sLabel}`,
	};
}

export interface RunPhaseResult {
	advanced: boolean;
	needsGate: boolean;
	agentResult?: SubAgentResult;
}

export async function runPhase(
	pi: ExtensionAPI,
	db: Database.Database,
	root: string,
	slice: Slice,
	milestoneNumber: number,
	phase: Phase,
	settings: Settings,
): Promise<RunPhaseResult> {
	const entryStatus = PHASE_ENTRY_STATUS[phase];
	updateSliceStatus(db, slice.id, entryStatus);

	const context = collectPhaseContext(root, slice, milestoneNumber, phase);
	const prompt = buildPhasePrompt(
		slice,
		milestoneNumber,
		phase,
		context,
		settings.compress.user_artifacts,
	);

	const agentName = PHASE_AGENT[phase];
	const agentResult = await dispatchSubAgent(pi, agentName, prompt);

	if (!agentResult.success) {
		return { advanced: false, needsGate: false, agentResult };
	}

	const next = nextSliceStatus(entryStatus, slice.tier ?? undefined);
	if (next) {
		updateSliceStatus(db, slice.id, next);
	}

	const needsGate = phase === "discuss" || phase === "plan";
	return { advanced: true, needsGate, agentResult };
}

export async function handleGate(
	pi: ExtensionAPI,
	_db: Database.Database,
	root: string,
	slice: Slice,
	milestoneNumber: number,
	phase: Phase,
): Promise<ReviewResult> {
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);

	let artifactName: string;
	let reviewType: "spec" | "plan";
	if (phase === "discuss") {
		artifactName = "SPEC.md";
		reviewType = "spec";
	} else {
		artifactName = "PLAN.md";
		reviewType = "plan";
	}

	const artifactPath = `milestones/${mLabel}/slices/${sLabel}/${artifactName}`;
	const content = readArtifact(root, artifactPath) ?? "";

	return requestReview(pi, artifactPath, content, reviewType);
}

export function advanceAfterGate(
	db: Database.Database,
	slice: Slice,
	reviewResult: ReviewResult,
): boolean {
	if (!reviewResult.approved) {
		return false;
	}

	const current = getSlice(db, slice.id);
	if (!current) return false;

	const next = nextSliceStatus(current.status, current.tier ?? undefined);
	if (next) {
		updateSliceStatus(db, slice.id, next);
	}
	return true;
}
