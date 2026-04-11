import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextBlock } from "../../../src/common/context-injection.js";

describe("context-injection", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `tff-ctx-inject-${Date.now()}`);
		mkdirSync(join(root, ".tff", "milestones", "M01", "slices", "M01-S01"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns empty string when no project info available", () => {
		const block = buildContextBlock({ root, project: null, milestone: null, slice: null });
		expect(block).toBe("");
	});

	it("includes project name and vision when available", () => {
		const block = buildContextBlock({
			root,
			project: { id: "p1", name: "TestProject", vision: "Build something", createdAt: "" },
			milestone: null,
			slice: null,
		});
		expect(block).toContain("TestProject");
		expect(block).toContain("Build something");
	});

	it("includes milestone info when available", () => {
		const block = buildContextBlock({
			root,
			project: { id: "p1", name: "P", vision: "V", createdAt: "" },
			milestone: {
				id: "m1",
				projectId: "p1",
				number: 1,
				name: "Foundation",
				status: "in_progress",
				branch: "milestone/M01",
				createdAt: "",
			},
			slice: null,
		});
		expect(block).toContain("M01");
		expect(block).toContain("Foundation");
	});

	it("includes slice info and phase-appropriate artifacts", () => {
		writeFileSync(
			join(root, ".tff", "milestones", "M01", "slices", "M01-S01", "SPEC.md"),
			"# Spec content",
			"utf-8",
		);
		const block = buildContextBlock({
			root,
			project: { id: "p1", name: "P", vision: "V", createdAt: "" },
			milestone: {
				id: "m1",
				projectId: "p1",
				number: 1,
				name: "M",
				status: "in_progress",
				branch: "milestone/M01",
				createdAt: "",
			},
			slice: {
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "Slice One",
				status: "executing",
				tier: "SS",
				prUrl: null,
				createdAt: "",
			},
		});
		expect(block).toContain("M01-S01");
		expect(block).toContain("executing");
		expect(block).toContain("Spec content");
	});

	it("includes worktree path when provided", () => {
		const block = buildContextBlock({
			root,
			project: { id: "p1", name: "P", vision: "V", createdAt: "" },
			milestone: {
				id: "m1",
				projectId: "p1",
				number: 1,
				name: "M",
				status: "in_progress",
				branch: "milestone/M01",
				createdAt: "",
			},
			slice: {
				id: "s1",
				milestoneId: "m1",
				number: 1,
				title: "S",
				status: "executing",
				tier: "SS",
				prUrl: null,
				createdAt: "",
			},
			worktreePath: "/tmp/wt",
		});
		expect(block).toContain("/tmp/wt");
	});
});
