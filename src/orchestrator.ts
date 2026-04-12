import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { readArtifact } from "./common/artifacts.js";
import {
	getActiveMilestone,
	getActiveSlice,
	getProject,
	getSlice,
	getTasksByWave,
} from "./common/db.js";
import type { Phase, Slice, SliceStatus, Task, Tier } from "./common/types.js";
import { milestoneLabel, sliceLabel } from "./common/types.js";

export type { Phase };

/** Prompt structure for phase prompts (kept for backward compat with tests). */
export interface PhasePrompt {
	systemPrompt: string;
	userPrompt: string;
	tools: string[];
	label: string;
}

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
		case "planning":
			return "execute";
		case "executing":
			return "verify";
		case "verifying":
			return "review";
		case "reviewing":
			return "ship";
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
	execute: "executor",
	verify: "verifier",
	review: "code-reviewer",
	ship: "executor",
};

const PHASE_TOOLS: Record<Phase, string[]> = {
	discuss: [
		"tff_classify",
		"tff_write_spec",
		"tff_write_requirements",
		"tff_query_state",
		"tff_confirm_gate",
		"tff_ask_user",
	],
	research: [
		"tff_write_research",
		"tff_query_state",
		"tff-fff_find",
		"tff-fff_grep",
		"tff-fff_search",
	],
	plan: ["tff_write_plan", "tff_query_state", "tff-fff_find", "tff-fff_grep", "tff_ask_user"],
	execute: ["tff_query_state", "tff-fff_find", "tff-fff_grep", "tff-fff_search"],
	verify: ["tff_query_state", "tff-fff_find", "tff-fff_grep"],
	review: ["tff_query_state", "tff-fff_find", "tff-fff_grep"],
	ship: ["tff_query_state"],
};

export function loadAgentResource(agentName: string): string {
	return loadResource(join(RESOURCES_DIR, "agents", `${agentName}.md`));
}

export function loadPhaseResources(phase: Phase): { agentPrompt: string; protocol: string } {
	const agentName = PHASE_AGENT[phase];
	const agentPrompt = loadResource(join(RESOURCES_DIR, "agents", `${agentName}.md`));
	const protocolFile = phase === "discuss" ? "discuss-interactive" : phase;
	const protocol = loadResource(join(RESOURCES_DIR, "protocols", `${protocolFile}.md`));
	return { agentPrompt, protocol };
}

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
): PhasePrompt {
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
			return `### ${name}\n\n${content}`;
		})
		.join("\n\n");

	const parts = [
		`## Slice: ${sLabel} — "${slice.title}"`,
		`Slice ID: ${slice.id}`,
		`Tier: ${slice.tier ?? "unclassified"}`,
		"",
		"## Context",
		"",
		contextBlock,
	];

	if (compressed) {
		parts.push(
			"",
			"**IMPORTANT:** Write all artifact content in compressed R1-R10 notation. Preserve: code blocks, file paths, AC checkboxes.",
		);
	}

	const userPrompt = parts.join("\n");

	return {
		systemPrompt,
		userPrompt,
		tools: PHASE_TOOLS[phase],
		label: `${phase}:${sLabel}`,
	};
}

export async function enrichContextWithFff(
	ctx: Record<string, string>,
	tasks: Task[],
	fffBridge: {
		grep: (patterns: string[], opts?: { maxResults?: number }) => Promise<Array<{ path: string }>>;
	},
): Promise<void> {
	const filePatterns = tasks
		.flatMap((t) => t.title.split(/\s+/))
		.filter((w) => w.length > 3)
		.slice(0, 5);
	if (filePatterns.length === 0) return;

	try {
		const results = await fffBridge.grep(filePatterns, { maxResults: 10 });
		if (results.length > 0) {
			ctx.RELATED_FILES = results.map((r) => r.path).join("\n");
		}
	} catch {
		// Best-effort — don't fail the phase
	}
}

export function verifyPhaseArtifacts(
	db: Database.Database,
	root: string,
	slice: Slice,
	milestoneNumber: number,
	phase: Phase,
): { ok: boolean; missing: string[] } {
	const mLabel = milestoneLabel(milestoneNumber);
	const sLabel = sliceLabel(milestoneNumber, slice.number);
	const missing: string[] = [];

	if (phase === "discuss") {
		if (!readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`)) {
			missing.push("SPEC.md");
		}
		if (!readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/REQUIREMENTS.md`)) {
			missing.push("REQUIREMENTS.md");
		}
		const refreshed = getSlice(db, slice.id);
		if (!refreshed?.tier) {
			missing.push("tier classification");
		}
	} else if (phase === "research") {
		const refreshed = getSlice(db, slice.id);
		if (refreshed?.tier === "SSS") {
			if (!readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/RESEARCH.md`)) {
				missing.push("RESEARCH.md (required for SSS)");
			}
		}
	} else if (phase === "plan") {
		if (!readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/PLAN.md`)) {
			missing.push("PLAN.md");
		}
		const waveMap = getTasksByWave(db, slice.id);
		if (waveMap.size === 0) {
			missing.push("tasks persisted in DB (tff_write_plan must be called)");
		}
	} else if (phase === "verify") {
		if (!readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/VERIFICATION.md`)) {
			missing.push("VERIFICATION.md");
		}
	} else if (phase === "review") {
		if (!readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/REVIEW.md`)) {
			missing.push("REVIEW.md");
		}
	}

	return { ok: missing.length === 0, missing };
}

/**
 * Returns the phase whose artifacts must exist before entering `target`.
 * null means no precondition (e.g., discuss is the first phase).
 */
export function predecessorPhase(target: Phase, tier?: Tier | null): Phase | null {
	switch (target) {
		case "discuss":
			return null;
		case "research":
			return "discuss";
		case "plan":
			return tier === "S" ? "discuss" : "research";
		case "execute":
			return "plan";
		case "verify":
			// Verify's own empty-diff check in verify.ts is the real gate; no artifact required here.
			return null;
		case "review":
			return "verify";
		case "ship":
			return "review";
		default:
			return null;
	}
}
