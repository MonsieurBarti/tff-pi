import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { readArtifact } from "./artifacts.js";
import { getSlices } from "./db.js";
import type { Slice } from "./types.js";
import { milestoneLabel, sliceLabel } from "./types.js";

export interface PreparationBrief {
	codebaseBrief: string;
	priorContext: string;
	relatedFiles: string;
	artifacts: {
		project: string | null;
		requirements: string | null;
		completedSpecs: string[];
	};
}

const MAX_CODEBASE_BRIEF = 3000;
const MAX_PRIOR_CONTEXT = 4000;

export async function buildPreparationBrief(
	root: string,
	db: Database.Database,
	slice: Slice,
	milestoneNumber: number,
): Promise<PreparationBrief> {
	const codebaseBrief = analyzeCodebase(root);
	const mLabel = milestoneLabel(milestoneNumber);

	// Load artifacts
	const project = readArtifact(root, "PROJECT.md");
	const requirements = readArtifact(root, `milestones/${mLabel}/REQUIREMENTS.md`);

	// Load completed slice specs from same milestone
	const allSlices = getSlices(db, slice.milestoneId);
	const completedSpecs: string[] = [];
	for (const s of allSlices) {
		if (s.id === slice.id) continue;
		if (s.status !== "closed") continue;
		const sLabel = sliceLabel(milestoneNumber, s.number);
		const spec = readArtifact(root, `milestones/${mLabel}/slices/${sLabel}/SPEC.md`);
		if (spec) completedSpecs.push(spec);
	}

	// Build prior context from completed specs
	const priorContext = buildPriorContext(completedSpecs);

	return {
		codebaseBrief,
		priorContext,
		relatedFiles: "", // fff-pi integration is best-effort, empty default
		artifacts: { project, requirements, completedSpecs },
	};
}

function analyzeCodebase(root: string): string {
	const sections: string[] = [];

	// Detect tech stack from package.json
	const pkgPath = join(root, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			const deps = Object.keys(pkg.dependencies ?? {});
			const devDeps = Object.keys(pkg.devDependencies ?? {});
			if (deps.length > 0) sections.push(`Dependencies: ${deps.join(", ")}`);
			if (devDeps.length > 0) sections.push(`Dev dependencies: ${devDeps.join(", ")}`);
			if (pkg.type) sections.push(`Module type: ${pkg.type}`);
		} catch {
			// Ignore parse errors
		}
	}

	// Detect TypeScript
	if (existsSync(join(root, "tsconfig.json"))) {
		sections.push("Language: TypeScript");
	}

	// Detect Rust
	if (existsSync(join(root, "Cargo.toml"))) {
		sections.push("Language: Rust");
		try {
			const cargo = readFileSync(join(root, "Cargo.toml"), "utf-8");
			const depSection = cargo.match(/\[dependencies\]([\s\S]*?)(\[|$)/);
			if (depSection?.[1]) {
				const cargoDeps = depSection[1]
					.split("\n")
					.filter((l) => l.includes("="))
					.map((l) => l.split("=")[0]?.trim())
					.filter(Boolean);
				if (cargoDeps.length > 0) sections.push(`Cargo deps: ${cargoDeps.join(", ")}`);
			}
		} catch {
			// Ignore
		}
	}

	// List top-level source directories
	const srcDir = join(root, "src");
	if (existsSync(srcDir)) {
		try {
			const entries = readdirSync(srcDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
			const files = entries.filter((e) => e.isFile()).map((e) => e.name);
			if (dirs.length > 0) sections.push(`Source directories: ${dirs.join(", ")}`);
			if (files.length > 0) sections.push(`Source root files: ${files.join(", ")}`);
		} catch {
			// Ignore
		}
	}

	const result = sections.join("\n");
	return result.length > MAX_CODEBASE_BRIEF
		? `${result.substring(0, MAX_CODEBASE_BRIEF)}\n[...truncated]`
		: result;
}

function buildPriorContext(completedSpecs: string[]): string {
	if (completedSpecs.length === 0) return "";

	const sections: string[] = ["Prior slice decisions:"];
	for (const spec of completedSpecs) {
		const designMatch = spec.match(/## Design\n([\s\S]*?)(?=\n## |$)/);
		const forwardMatch = spec.match(/## Forward Intelligence\n([\s\S]*?)(?=\n## |$)/);
		if (designMatch?.[1]) {
			sections.push(`- Design: ${designMatch[1].trim().substring(0, 200)}`);
		}
		if (forwardMatch?.[1]) {
			sections.push(`- Forward: ${forwardMatch[1].trim().substring(0, 200)}`);
		}
	}

	const result = sections.join("\n");
	return result.length > MAX_PRIOR_CONTEXT
		? `${result.substring(0, MAX_PRIOR_CONTEXT)}\n[...truncated]`
		: result;
}
