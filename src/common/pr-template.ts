import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifact, tffPath } from "./artifacts.js";

const BUILTIN_TEMPLATE_PATH = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
	"resources",
	"templates",
	"pr-body.md",
);

export const PR_TEMPLATE_FIELDS = [
	"description",
	"testSteps",
	"trickyParts",
	"deploymentSteps",
	"envVars",
] as const;

export type PrTemplateField = (typeof PR_TEMPLATE_FIELDS)[number];

export type PrTemplateValues = Partial<Record<PrTemplateField, string | undefined>>;

export function loadPrTemplate(root: string): string {
	const override = readArtifact(root, "templates/pr-body.md");
	if (override && override.trim().length > 0) {
		return override;
	}
	return readFileSync(BUILTIN_TEMPLATE_PATH, "utf-8");
}

export function renderPrTemplate(template: string, values: PrTemplateValues): string {
	let rendered = template;
	for (const field of PR_TEMPLATE_FIELDS) {
		const value = values[field];
		const placeholder = `{{${field}}}`;
		rendered = rendered.split(placeholder).join(value?.trim() ? value.trim() : "_(none)_");
	}
	return rendered;
}

export function prTemplateOverridePath(root: string): string {
	return tffPath(root, "templates", "pr-body.md");
}
