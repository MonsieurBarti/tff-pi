import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import { loadPrTemplate, renderPrTemplate } from "../../../src/common/pr-template.js";

describe("pr-template", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-pr-template-"));
		initTffDirectory(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("loads the builtin template when no override exists", () => {
		const tpl = loadPrTemplate(root);
		expect(tpl).toContain("{{description}}");
		expect(tpl).toContain("{{testSteps}}");
		expect(tpl).toContain("PR Checklist");
	});

	it("loads project override from .tff/templates/pr-body.md", () => {
		writeArtifact(root, "templates/pr-body.md", "# Custom\n\n{{description}}");
		const tpl = loadPrTemplate(root);
		expect(tpl).toBe("# Custom\n\n{{description}}");
	});

	it("ignores empty override and falls back to builtin", () => {
		writeArtifact(root, "templates/pr-body.md", "   \n  ");
		const tpl = loadPrTemplate(root);
		expect(tpl).toContain("PR Checklist");
	});

	it("renders values into placeholders", () => {
		const tpl = "# Desc\n\n{{description}}\n\n# Test\n\n{{testSteps}}";
		const out = renderPrTemplate(tpl, {
			description: "Adds auth",
			testSteps: "1. Run\n2. Verify",
		});
		expect(out).toContain("Adds auth");
		expect(out).toContain("1. Run");
		expect(out).not.toContain("{{description}}");
		expect(out).not.toContain("{{testSteps}}");
	});

	it("substitutes empty placeholders with _(none)_", () => {
		const tpl = "{{description}} / {{trickyParts}}";
		const out = renderPrTemplate(tpl, { description: "x" });
		expect(out).toBe("x / _(none)_");
	});

	it("replaces multiple occurrences of the same placeholder", () => {
		const tpl = "{{description}} and {{description}}";
		const out = renderPrTemplate(tpl, { description: "x" });
		expect(out).toBe("x and x");
	});
});
