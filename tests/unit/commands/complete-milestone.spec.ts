import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestone,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSlicePrUrl,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

const mockExec = vi.fn().mockReturnValue("");
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		execFileSync: (...args: unknown[]) => mockExec(...args),
	};
});

vi.mock("../../../src/common/git.js", () => ({
	getDefaultBranch: vi.fn().mockReturnValue("main"),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
	getDiff: vi.fn().mockReturnValue(""),
	gitEnv: vi.fn().mockReturnValue({}),
}));

import { handleCompleteMilestone } from "../../../src/commands/complete-milestone.js";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
	return {
		...DEFAULT_SETTINGS,
		compress: { ...DEFAULT_SETTINGS.compress },
		ship: { ...DEFAULT_SETTINGS.ship },
		...overrides,
	};
}

const REQUIRED_ARTIFACTS = [
	"SPEC.md",
	"PLAN.md",
	"REQUIREMENTS.md",
	"VERIFICATION.md",
	"REVIEW.md",
];

function writeAllArtifacts(root: string, milestoneNum: number, sliceNum: number): void {
	const mLabel = `M${String(milestoneNum).padStart(2, "0")}`;
	const sLabel = `${mLabel}-S${String(sliceNum).padStart(2, "0")}`;
	const base = `milestones/${mLabel}/slices/${sLabel}`;
	for (const artifact of REQUIRED_ARTIFACTS) {
		writeArtifact(root, `${base}/${artifact}`, `# ${artifact}\nContent`);
	}
}

describe("handleCompleteMilestone", () => {
	let db: Database.Database;
	let root: string;
	let milestoneId: string;

	beforeEach(() => {
		mockExec.mockReset();
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string;
			const cmdArgs = args[1] as string[];
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "create") {
				return "https://github.com/org/repo/pull/99\n";
			}
			return "";
		});

		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-complete-milestone-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "Foundation", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates milestone PR when all slices are closed", () => {
		// Add 2 closed slices with all artifacts
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		for (const s of slices) {
			updateSliceStatus(db, s.id, "closed");
		}
		writeAllArtifacts(root, 1, 1);
		writeAllArtifacts(root, 1, 2);

		const result = handleCompleteMilestone(db, root, milestoneId, makeSettings());
		expect(result.success).toBe(true);
		expect(result.prUrl).toContain("github.com");

		// Milestone status should be "completing"
		const milestone = must(getMilestone(db, milestoneId));
		expect(milestone.status).toBe("completing");
	});

	it("rejects when slices are still open", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		updateSliceStatus(db, must(slices[0]).id, "closed");
		// Leave slices[1] as "created"

		const result = handleCompleteMilestone(db, root, milestoneId, makeSettings());
		expect(result.success).toBe(false);
		expect(result.error).toContain("not closed");
	});

	it("self-heals stale slice state when PR is merged", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		updateSliceStatus(db, must(slices[0]).id, "closed");
		writeAllArtifacts(root, 1, 1);

		// Slice 2 is stuck at "shipping" with a prUrl
		updateSliceStatus(db, must(slices[1]).id, "shipping");
		updateSlicePrUrl(db, must(slices[1]).id, "https://github.com/org/repo/pull/42");
		writeAllArtifacts(root, 1, 2);

		// Mock gh pr view to return MERGED for the stale slice
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string;
			const cmdArgs = args[1] as string[];
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "view") {
				return JSON.stringify({ state: "MERGED" });
			}
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "create") {
				return "https://github.com/org/repo/pull/99\n";
			}
			return "";
		});

		const result = handleCompleteMilestone(db, root, milestoneId, makeSettings());
		expect(result.success).toBe(true);
		expect(result.prUrl).toContain("github.com");
	});

	it("validates artifacts for all slices", () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const slices = getSlices(db, milestoneId);
		updateSliceStatus(db, must(slices[0]).id, "closed");
		// Do NOT write artifacts

		const result = handleCompleteMilestone(db, root, milestoneId, makeSettings());
		expect(result.success).toBe(false);
		expect(result.error).toContain("artifact");
	});
});
