import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, readArtifact, writeArtifact } from "../../../src/common/artifacts.js";
import { compressIfEnabled } from "../../../src/common/compress.js";
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
	updateSlicePrUrl,
	updateSliceTier,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/common/settings.js";
import { must } from "../../helpers.js";

const mockExec = vi.fn().mockReturnValue("");
vi.mock("node:child_process", () => ({
	execFileSync: (...args: unknown[]) => mockExec(...args),
}));

const mockView = vi.fn();
const mockCreate = vi.fn();
const mockChecks = vi.fn();
const mockMerge = vi.fn();

vi.mock("@the-forge-flow/gh-pi", () => ({
	createGHClient: vi.fn(() => ({})),
	createPRTools: vi.fn(() => ({
		view: mockView,
		create: mockCreate,
		checks: mockChecks,
		merge: mockMerge,
	})),
}));

vi.mock("../../../src/common/checkpoint.js", () => ({
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	removeWorktree: vi.fn(),
}));

vi.mock("../../../src/common/compress.js", () => ({
	compressIfEnabled: vi.fn((input: string) => input),
}));

vi.mock("../../../src/common/git.js", () => ({
	getDefaultBranch: vi.fn().mockReturnValue("main"),
	getGitRoot: vi.fn().mockReturnValue("/tmp"),
	getCurrentBranch: vi.fn().mockReturnValue("main"),
	branchExists: vi.fn().mockReturnValue(true),
	createBranch: vi.fn(),
	pushBranch: vi.fn(),
	remoteBranchExists: vi.fn().mockReturnValue(true),
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
			if (cmd === "git" && cmdArgs?.[0] === "remote" && cmdArgs?.[1] === "get-url") {
				return "git@github.com:org/repo.git\n";
			}
			return "";
		});

		mockView.mockReset().mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ state: "OPEN", comments: [] }),
			stderr: "",
		});
		mockCreate.mockReset().mockResolvedValue({
			code: 0,
			stdout: "https://github.com/org/repo/pull/42",
			stderr: "",
		});
		mockChecks.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		mockMerge.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

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
		db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("reviewing", sliceId);
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
		writeArtifact(
			root,
			"milestones/M01/slices/M01-S01/PR.md",
			"# Description\n\nAuthored during verify.",
		);
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
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
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
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		await shipPhase.prepare(ctx);
		const prMd = readArtifact(root, "milestones/M01/slices/M01-S01/PR.md");
		expect(prMd).not.toBeNull();
		expect(prMd).toContain("github.com");
	});

	it("compresses PR.md content when enabled", async () => {
		vi.mocked(compressIfEnabled).mockReturnValueOnce("[COMPRESSED]pr");
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		await shipPhase.prepare(ctx);
		const prMd = readArtifact(root, "milestones/M01/slices/M01-S01/PR.md");
		expect(prMd).toBe("[COMPRESSED]pr");
	});

	it("emits phase_complete for ship after successful merge (reconciler rule 1 closes slice)", async () => {
		const slice = must(getSlice(db, sliceId));
		const pi = makePi();
		const ctx: PhaseContext = {
			pi,
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		await shipPhase.prepare(ctx);
		// Reconciler rule 1: ship/completed + pr_url non-null → closed.
		// Verify phase_complete was emitted; pr_url must be persisted for the rule to fire.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_complete", phase: "ship" }),
		);
		const updated = must(getSlice(db, sliceId));
		expect(updated.prUrl).toContain("github.com");
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
			settings: makeSettings({ ship: { auto_merge: false, merge_method: "squash" } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(true);

		// pr merge should NOT have been called
		expect(mockMerge).not.toHaveBeenCalled();

		// sendUserMessage should hand the merge gate to the agent — include
		// PR URL, tff_ask_user instruction, and tool routing.
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const msg = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		expect(msg).toContain("PR is open");
		expect(msg).toContain("tff_ask_user");
		expect(msg).toContain("tff_ship_merged");
		expect(msg).toContain("tff_ship_changes");
	});

	it("creates PR via prTools.create with correct parameters", async () => {
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		await shipPhase.prepare(ctx);
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				repo: "org/repo",
				title: expect.stringContaining("M01-S01"),
				head: "slice/M01-S01",
				base: "milestone/M01",
			}),
		);
	});

	it("re-entry: merged PR emits phase_complete (reconciler rule 1 closes slice)", async () => {
		mockView.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ state: "MERGED", comments: [] }),
			stderr: "",
		});
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		const slice = must(getSlice(db, sliceId));
		const pi = makePi();
		const ctx: PhaseContext = {
			pi,
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(true);
		// Reconciler rule 1: ship/completed + pr_url non-null → closed.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_complete", phase: "ship" }),
		);
	});

	it("re-entry: PR with comments stashes feedback and emits phase_retried for ship", async () => {
		mockView.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({
				state: "OPEN",
				comments: [{ body: "please fix", author: { login: "reviewer" } }],
			}),
			stderr: "",
		});
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		const slice = must(getSlice(db, sliceId));
		const pi = makePi();
		const ctx: PhaseContext = {
			pi,
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(result.retry).toBe(false);
		// Reconciler rule 2 (ship/retried → shipping) handles status transition.
		// phase_retried is emitted; tasks are NOT reset automatically.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_retried", phase: "ship" }),
		);
		const stashed = readArtifact(root, "milestones/M01/slices/M01-S01/REVIEW_FEEDBACK.md");
		expect(stashed).toContain("please fix");
	});

	it("re-entry: open PR with no comments returns waiting", async () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(mockMerge).not.toHaveBeenCalled();
	});

	it("CI failure triggers retry path and emits phase_failed for ship", async () => {
		mockChecks.mockResolvedValue({ code: 1, stdout: "", stderr: "checks failed" });
		const slice = must(getSlice(db, sliceId));
		const pi = makePi();
		const ctx: PhaseContext = {
			pi,
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		// Reconciler rule 3 (ship/failed → executing) handles status transition.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_failed", phase: "ship" }),
		);
	});

	it("returns error for invalid PR URL", async () => {
		updateSlicePrUrl(db, sliceId, "not a url");
		const slice = must(getSlice(db, sliceId));
		const ctx: PhaseContext = {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: makeSettings({ ship: { auto_merge: true, merge_method: "squash" } }),
		};
		const result = await shipPhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid PR URL");
	});
});
