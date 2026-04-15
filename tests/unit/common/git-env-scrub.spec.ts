import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "../../../src/common/git.js";

// Regression guard for the GIT_INDEX_FILE leak that caused "ghost staging":
// when a pre-commit hook runs, git sets GIT_INDEX_FILE pointing at the outer
// worktree's index. If a test's `git add` inherits that env var, the index
// entry lands in the outer index while the blob is written to the temp
// repo's objects (which then gets rmSync'd, leaving the outer index pointing
// at a missing object). See src/common/git.ts:gitEnv for the scrub list.
describe("gitEnv() — redirect-var scrub", () => {
	let outerRepo: string;
	let innerRepo: string;

	beforeEach(() => {
		outerRepo = mkdtempSync(join(tmpdir(), "tff-env-outer-"));
		innerRepo = mkdtempSync(join(tmpdir(), "tff-env-inner-"));
		for (const dir of [outerRepo, innerRepo]) {
			execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "pipe" });
			execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
				cwd: dir,
				stdio: "pipe",
			});
		}
	});

	afterEach(() => {
		rmSync(outerRepo, { recursive: true, force: true });
		rmSync(innerRepo, { recursive: true, force: true });
		for (const k of [
			"GIT_INDEX_FILE",
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_PREFIX",
			"GIT_COMMON_DIR",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		]) {
			delete process.env[k];
		}
	});

	it("scrubs GIT_INDEX_FILE so a leaked value does not redirect git add to the outer index", () => {
		const outerIdx = join(outerRepo, ".git", "index");
		// Simulate lefthook leak: GIT_INDEX_FILE in process.env points at outer.
		process.env.GIT_INDEX_FILE = outerIdx;
		writeFileSync(join(innerRepo, "foo.txt"), "hello\n");

		const before = statSync(outerIdx).mtimeMs;
		execFileSync("git", ["add", "--", "foo.txt"], {
			cwd: innerRepo,
			stdio: "pipe",
			env: gitEnv(),
		});
		const after = statSync(outerIdx).mtimeMs;

		expect(after).toBe(before);

		// The inner repo's index must contain foo.txt (add went where it should).
		const innerIndex = execFileSync("git", ["ls-files", "--stage"], {
			cwd: innerRepo,
			encoding: "utf-8",
			env: gitEnv(),
		});
		expect(innerIndex).toContain("foo.txt");
	});

	it("demonstrates the failure mode when GIT_INDEX_FILE is NOT scrubbed (canary)", () => {
		// Negative control: prove that without the scrub, the bug reproduces.
		// This guards against future refactors that might accidentally drop
		// GIT_INDEX_FILE from the scrub list and silently pass the positive test.
		const outerIdx = join(outerRepo, ".git", "index");
		writeFileSync(join(innerRepo, "leak.txt"), "leak\n");

		const before = statSync(outerIdx).mtimeMs;
		// Intentionally skip gitEnv(): pass env with GIT_INDEX_FILE set.
		execFileSync("git", ["add", "--", "leak.txt"], {
			cwd: innerRepo,
			stdio: "pipe",
			env: { ...process.env, GIT_INDEX_FILE: outerIdx },
		});
		const after = statSync(outerIdx).mtimeMs;

		// Without scrubbing, outer index IS touched — this is the bug.
		expect(after).toBeGreaterThan(before);
	});

	it("strips the full redirect set (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_PREFIX)", () => {
		for (const key of [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_COMMON_DIR",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_PREFIX",
		]) {
			process.env[key] = "/should-be-scrubbed";
		}
		const env = gitEnv();
		for (const key of [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_COMMON_DIR",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_PREFIX",
		]) {
			expect(env[key]).toBeUndefined();
		}
	});

	it("preserves non-GIT env vars (e.g. PATH) so spawned git is still findable", () => {
		expect(gitEnv().PATH).toBe(process.env.PATH);
	});
});
