import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupCheckpoints,
	createCheckpoint,
	getLastCheckpoint,
	listCheckpoints,
} from "../../../src/common/checkpoint.js";
import { gitEnv } from "../../../src/common/git.js";

describe("checkpoint", () => {
	let repo: string;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save and clear GIT_* env vars to isolate from lefthook/worktree context
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		repo = join(tmpdir(), `tff-checkpoint-test-${Date.now()}`);
		mkdirSync(repo, { recursive: true });
		const env = gitEnv();
		execFileSync("git", ["init"], { cwd: repo, env });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo, env });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, env });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo, env });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		// Restore GIT_* env vars
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("createCheckpoint creates a lightweight tag", () => {
		createCheckpoint(repo, "M01-S01", "pre-execute");
		const tags = execFileSync("git", ["tag", "-l", "checkpoint/*"], {
			cwd: repo,
			encoding: "utf-8",
			env: gitEnv(),
		}).trim();
		expect(tags).toBe("checkpoint/M01-S01/pre-execute");
	});

	it("listCheckpoints returns all tags for a slice", () => {
		createCheckpoint(repo, "M01-S01", "pre-execute");
		execFileSync("git", ["commit", "--allow-empty", "-m", "wave 1"], { cwd: repo, env: gitEnv() });
		createCheckpoint(repo, "M01-S01", "wave-1");

		const checkpoints = listCheckpoints(repo, "M01-S01");
		expect(checkpoints).toHaveLength(2);
		expect(checkpoints).toContain("checkpoint/M01-S01/pre-execute");
		expect(checkpoints).toContain("checkpoint/M01-S01/wave-1");
	});

	it("listCheckpoints returns empty array for unknown slice", () => {
		expect(listCheckpoints(repo, "M99-S99")).toEqual([]);
	});

	it("getLastCheckpoint returns the most recent tag", () => {
		createCheckpoint(repo, "M01-S01", "pre-execute");
		execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: repo, env: gitEnv() });
		createCheckpoint(repo, "M01-S01", "wave-1");

		const last = getLastCheckpoint(repo, "M01-S01");
		expect(last).toBe("checkpoint/M01-S01/wave-1");
	});

	it("getLastCheckpoint returns null when no checkpoints exist", () => {
		expect(getLastCheckpoint(repo, "M01-S01")).toBeNull();
	});

	it("cleanupCheckpoints removes all tags for a slice", () => {
		createCheckpoint(repo, "M01-S01", "pre-execute");
		createCheckpoint(repo, "M01-S01", "wave-1");
		createCheckpoint(repo, "M01-S02", "pre-execute"); // different slice

		cleanupCheckpoints(repo, "M01-S01");

		expect(listCheckpoints(repo, "M01-S01")).toEqual([]);
		expect(listCheckpoints(repo, "M01-S02")).toHaveLength(1); // unaffected
	});

	it("createCheckpoint is idempotent (overwrites existing tag)", () => {
		createCheckpoint(repo, "M01-S01", "pre-execute");
		execFileSync("git", ["commit", "--allow-empty", "-m", "more work"], {
			cwd: repo,
			env: gitEnv(),
		});
		createCheckpoint(repo, "M01-S01", "pre-execute"); // overwrite

		const checkpoints = listCheckpoints(repo, "M01-S01");
		expect(checkpoints).toHaveLength(1);
	});
});
