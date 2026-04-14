import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

const mockView = vi.fn();
const mockCreate = vi.fn();

vi.mock("@the-forge-flow/gh-pi", () => ({
	createGHClient: vi.fn(() => ({})),
	createPRTools: vi.fn(() => ({
		view: mockView,
		create: mockCreate,
		checks: vi.fn(),
		merge: vi.fn(),
	})),
}));

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

function makeMockPi(): ExtensionAPI {
	return {
		events: {
			emit: vi.fn(),
			on: vi.fn(),
			once: vi.fn(),
			off: vi.fn(),
		},
		sendUserMessage: vi.fn(),
		commands: {
			executeCommand: vi.fn(),
		},
	} as unknown as ExtensionAPI;
}

const REQUIRED_ARTIFACTS = [
	"SPEC.md",
	"PLAN.md",
	"REQUIREMENTS.md",
	"VERIFICATION.md",
	"REVIEW.md",
	"PR.md",
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
	let mockPi: ExtensionAPI;

	beforeEach(() => {
		mockPi = makeMockPi();
		mockExec.mockReset();
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string;
			const cmdArgs = args[1] as string[];
			if (cmd === "git" && cmdArgs?.[0] === "remote" && cmdArgs?.[1] === "get-url") {
				return "git@github.com:org/repo.git\n";
			}
			return "";
		});

		mockView.mockReset().mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ state: "MERGED" }),
			stderr: "",
		});
		mockCreate.mockReset().mockResolvedValue({
			code: 0,
			stdout: "https://github.com/org/repo/pull/99",
			stderr: "",
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

	it("creates milestone PR when all slices are closed", async () => {
		// Add 2 closed slices with all artifacts
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		for (const s of slices) {
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", s.id);
		}
		writeAllArtifacts(root, 1, 1);
		writeAllArtifacts(root, 1, 2);

		const result = await handleCompleteMilestone(db, root, milestoneId, makeSettings(), mockPi);
		expect(result.success).toBe(true);
		expect(result.prUrl).toContain("github.com");

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				title: expect.stringContaining("M01"),
				head: "milestone/M01",
				base: "main",
			}),
		);

		// Milestone status should be "completing"
		const milestone = must(getMilestone(db, milestoneId));
		expect(milestone.status).toBe("completing");
	});

	it("rejects when slices are still open", async () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", must(slices[0]).id);
		// Leave slices[1] as "created"

		const result = await handleCompleteMilestone(db, root, milestoneId, makeSettings(), mockPi);
		expect(result.success).toBe(false);
		expect(result.error).toContain("not closed");
	});

	it("self-heals stale slice state when PR is merged", async () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		insertSlice(db, { milestoneId, number: 2, title: "DB" });
		const slices = getSlices(db, milestoneId);
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", must(slices[0]).id);
		writeAllArtifacts(root, 1, 1);

		// Slice 2 is stuck at "shipping" with a prUrl
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("shipping", must(slices[1]).id);
		updateSlicePrUrl(db, must(slices[1]).id, "https://github.com/org/repo/pull/42");
		writeAllArtifacts(root, 1, 2);

		// mockView defaults to MERGED, mockCreate defaults to a PR URL — both already set in beforeEach

		const result = await handleCompleteMilestone(db, root, milestoneId, makeSettings(), mockPi);
		expect(result.success).toBe(true);
		expect(result.prUrl).toContain("github.com");

		expect(mockView).toHaveBeenCalledWith(
			expect.objectContaining({
				repo: "org/repo",
				number: 42,
			}),
		);
	});

	it("validates artifacts for all slices", async () => {
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const slices = getSlices(db, milestoneId);
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", must(slices[0]).id);
		// Do NOT write artifacts

		const result = await handleCompleteMilestone(db, root, milestoneId, makeSettings(), mockPi);
		expect(result.success).toBe(false);
		expect(result.error).toContain("artifact");
	});
});
