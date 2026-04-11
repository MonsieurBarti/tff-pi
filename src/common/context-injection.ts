import { readArtifact } from "./artifacts.js";
import type { Milestone, Project, Slice } from "./types.js";
import { milestoneLabel, sliceLabel } from "./types.js";
import { getWorktreePath, worktreeExists } from "./worktree.js";

interface ContextInput {
	root: string;
	project: Project | null;
	milestone: Milestone | null;
	slice: Slice | null;
	worktreePath?: string;
}

const ARTIFACT_MAP: Record<string, string[]> = {
	discussing: ["PROJECT.md"],
	researching: ["SPEC.md", "REQUIREMENTS.md"],
	planning: ["SPEC.md", "REQUIREMENTS.md", "RESEARCH.md"],
	executing: ["SPEC.md", "PLAN.md"],
	verifying: ["SPEC.md", "PLAN.md"],
	reviewing: ["SPEC.md", "VERIFICATION.md"],
	shipping: ["SPEC.md", "REVIEW.md"],
};

export function buildContextBlock(input: ContextInput): string {
	const { root, project, milestone, slice, worktreePath } = input;
	if (!project) return "";

	const lines: string[] = [
		"## TFF Context",
		"",
		`**Project:** ${project.name}`,
		`**Vision:** ${project.vision}`,
	];

	if (milestone) {
		const mLabel = milestoneLabel(milestone.number);
		lines.push("", `**Milestone:** ${mLabel} — ${milestone.name} (${milestone.status})`);

		if (slice) {
			const sLabel = sliceLabel(milestone.number, slice.number);
			lines.push(
				`**Slice:** ${sLabel} — ${slice.title}`,
				`**Status:** ${slice.status}`,
				`**Tier:** ${slice.tier ?? "unclassified"}`,
			);

			// Inject worktree path
			const wtPath =
				worktreePath ?? (worktreeExists(root, sLabel) ? getWorktreePath(root, sLabel) : null);
			if (wtPath) {
				lines.push(`**Worktree:** ${wtPath}`);
			}

			// Inject phase-appropriate artifacts
			const artifactNames = ARTIFACT_MAP[slice.status] ?? [];
			for (const name of artifactNames) {
				const artifactPath =
					name === "PROJECT.md"
						? "PROJECT.md"
						: name === "REQUIREMENTS.md" && slice.status === "discussing"
							? `milestones/${mLabel}/REQUIREMENTS.md`
							: `milestones/${mLabel}/slices/${sLabel}/${name}`;

				const content = readArtifact(root, artifactPath);
				if (content) {
					lines.push("", `### ${name}`, "", content);
				}
			}
		}
	}

	return lines.join("\n");
}
