import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	artifactExists,
	initMilestoneDir,
	initSliceDir,
	milestoneDir,
	readArtifact,
	sliceDir,
	tffPath,
	writeArtifact,
} from "../../../src/common/artifacts.js";

describe("artifacts", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("tffPath", () => {
		it("joins root + .tff + segments", () => {
			expect(tffPath(root, "milestones", "M01")).toBe(
				join(root, ".pi", ".tff", "milestones", "M01"),
			);
		});

		it("works with no extra segments", () => {
			expect(tffPath(root)).toBe(join(root, ".pi", ".tff"));
		});
	});

	describe("milestoneDir", () => {
		it("returns .tff/milestones/M01 for number 1", () => {
			expect(milestoneDir(root, 1)).toBe(join(root, ".pi", ".tff", "milestones", "M01"));
		});

		it("pads single digit numbers", () => {
			expect(milestoneDir(root, 3)).toBe(join(root, ".pi", ".tff", "milestones", "M03"));
		});

		it("handles two-digit numbers", () => {
			expect(milestoneDir(root, 12)).toBe(join(root, ".pi", ".tff", "milestones", "M12"));
		});
	});

	describe("sliceDir", () => {
		it("returns correct path for M01/S03", () => {
			expect(sliceDir(root, 1, 3)).toBe(
				join(root, ".pi", ".tff", "milestones", "M01", "slices", "M01-S03"),
			);
		});

		it("pads milestone and slice numbers", () => {
			expect(sliceDir(root, 2, 5)).toBe(
				join(root, ".pi", ".tff", "milestones", "M02", "slices", "M02-S05"),
			);
		});
	});

	describe("writeArtifact / readArtifact", () => {
		beforeEach(() => {
			mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		});

		it("round-trips content", () => {
			writeArtifact(root, "milestones/M01/brief.md", "# Brief\nHello");
			const content = readArtifact(root, "milestones/M01/brief.md");
			expect(content).toBe("# Brief\nHello");
		});

		it("creates parent directories automatically", () => {
			writeArtifact(root, "milestones/M01/slices/M01-S01/plan.md", "plan content");
			const content = readArtifact(root, "milestones/M01/slices/M01-S01/plan.md");
			expect(content).toBe("plan content");
		});

		it("overwrites existing content", () => {
			writeArtifact(root, "test.md", "first");
			writeArtifact(root, "test.md", "second");
			expect(readArtifact(root, "test.md")).toBe("second");
		});
	});

	describe("readArtifact", () => {
		beforeEach(() => {
			mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		});

		it("returns null for missing file", () => {
			expect(readArtifact(root, "nonexistent.md")).toBeNull();
		});
	});

	describe("artifactExists", () => {
		beforeEach(() => {
			mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		});

		it("returns true for existing file", () => {
			writeArtifact(root, "exists.md", "content");
			expect(artifactExists(root, "exists.md")).toBe(true);
		});

		it("returns false for missing file", () => {
			expect(artifactExists(root, "missing.md")).toBe(false);
		});
	});

	describe("initMilestoneDir", () => {
		beforeEach(() => {
			mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		});

		it("creates milestone directory", () => {
			initMilestoneDir(root, 1);
			expect(existsSync(join(root, ".pi", ".tff", "milestones", "M01"))).toBe(true);
		});

		it("is idempotent", () => {
			initMilestoneDir(root, 1);
			expect(() => initMilestoneDir(root, 1)).not.toThrow();
		});
	});

	describe("initSliceDir", () => {
		beforeEach(() => {
			mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
			initMilestoneDir(root, 1);
		});

		it("creates slice directory under milestone", () => {
			initSliceDir(root, 1, 3);
			expect(existsSync(join(root, ".pi", ".tff", "milestones", "M01", "slices", "M01-S03"))).toBe(
				true,
			);
		});

		it("is idempotent", () => {
			initSliceDir(root, 1, 3);
			expect(() => initSliceDir(root, 1, 3)).not.toThrow();
		});
	});
});
