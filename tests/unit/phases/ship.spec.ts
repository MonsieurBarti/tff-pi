import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, readArtifact, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

const mockExec = vi.fn().mockReturnValue("");
vi.mock("node:child_process", () => ({
	execFileSync: (...args: unknown[]) => mockExec(...args),
}));

vi.mock("../../../src/common/checkpoint.js", () => ({
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	removeWorktree: vi.fn(),
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

import { shipPhase } from "../../../src/phases/ship.js";

describe("shipPhase", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;
	let milestoneId: string;

	beforeEach(() => {
		mockExec.mockReset();
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string;
			const cmdArgs = args[1] as string[];
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "create") {
				return "https://github.com/org/repo/pull/42\n";
			}
			if (cmd === "gh" && cmdArgs?.[0] === "pr" && cmdArgs?.[1] === "checks") {
				return "All checks passed\n";
			}
			return "";
		});

		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-ship-test-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "Vision" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceStatus(db, sliceId, "reviewing");
		updateSliceTier(db, sliceId, "SS");
		writeArtifact(root, "milestones/M01/slices/M01-S01/SPEC.md", "# Spec\nAC-1: auth works");
		writeArtifact(root, "milestones/M01/slices/M01-S01/PLAN.md", "# Plan\nStep 1: implement");
		writeArtifact(
			root,
			"milestones/M01/slices/M01-S01/REQUIREMENTS.md",
			"# Requirements\nR1: auth",
		);
		writeArtifact(root, "milestones/M01/slices/M01-S01/VERIFICATION.md", "# All pass");
		writeArtifact(root, "milestones/M01/slices/M01-S01/REVIEW.md", "# Review\nAll good");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function makeSettings(overrides: Partial<Settings> = {}): Settings {
		return {
			...DEFAULT_SETTINGS,
			compress: { ...DEFAULT_SETTINGS.compress },
			ship: { ...DEFAULT_SETTINGS.ship },
			...overrides,
		};
	}

	function makePi() {
		return {
			events: { emit: vi.fn(), on: vi.fn() },
			sendUserMessage: vi.fn(),
		} as unknown as PhaseContext["pi"];
	}

	it("conforms to PhaseModule interface", () => {
		expect(typeof shipPhase.prepare).toBe("function");
	});

	it("stores pr_url on slice after PR creation", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(true);
		const updated = must(getSlice(db, sliceId));
		expect(updated.prUrl).toContain("github.com");
	});

	it("writes PR.md artifact", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true } }),
		};
		await shipPhase.prepare(ctx);
		const prMd = readArtifact(root, "milestones/M01/slices/M01-S01/PR.md");
		expect(prMd).not.toBeNull();
		expect(prMd).toContain("github.com");
	});

	it("marks slice as closed after successful merge", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true } }),
		};
		await shipPhase.prepare(ctx);
		const updated = must(getSlice(db, sliceId));
		expect(updated.status).toBe("closed");
	});

	it("with auto_merge disabled, does not squash merge", async () => {
		const slice = must(getSlice(db, sliceId));
		const pi = makePi();
		const ctx: PhaseContext = {
			pi,
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: false } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(true);

		// gh pr merge should NOT have been called
		const mergeCalls = mockExec.mock.calls.filter(
			(call: unknown[]) =>
				call[0] === "gh" &&
				(call[1] as string[])?.[0] === "pr" &&
				(call[1] as string[])?.[1] === "merge",
		);
		expect(mergeCalls).toHaveLength(0);

		// sendUserMessage should mention "ready for review"
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const msg = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		expect(msg).toContain("ready for review");
	});
});
