import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PROTECTED,
	detectProtectedPush,
	installProtectedBranchHook,
} from "../../../src/common/protected-branches.js";

describe("protected-branches", () => {
	let repoDir: string;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Isolate from lefthook/worktree GIT_* context
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		repoDir = mkdtempSync(join(tmpdir(), "tff-pb-test-"));
		execSync("git init", { cwd: repoDir, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'init'", { cwd: repoDir, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	// ---------------------------------------------------------------------------
	// installProtectedBranchHook
	// ---------------------------------------------------------------------------

	describe("installProtectedBranchHook", () => {
		it("fresh project: installs hook and sets core.hooksPath", () => {
			const result = installProtectedBranchHook(repoDir);
			expect(result.status).toBe("installed");

			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");
			expect(existsSync(hookPath)).toBe(true);

			// Check it's executable
			const mode = statSync(hookPath).mode;
			// 0o111 = owner+group+other execute bits
			expect(mode & 0o111).toBeGreaterThan(0);

			// Contains expected content
			const content = readFileSync(hookPath, "utf-8");
			expect(content).toContain("protected branch");
			expect(content).toContain("#!/usr/bin/env bash");
			expect(content).toContain("main");
			expect(content).toContain("master");

			// core.hooksPath is set
			const hooksPath = execSync("git config --get core.hooksPath", {
				cwd: repoDir,
				encoding: "utf-8",
				stdio: "pipe",
			}).trim();
			expect(hooksPath).toBe(".tff/hooks");
		});

		it("existing core.hooksPath (user has lefthook): writes hook + README, does NOT overwrite hooksPath", () => {
			// Pre-configure a custom hooksPath
			execSync("git config core.hooksPath .lefthook", { cwd: repoDir, stdio: "pipe" });

			const result = installProtectedBranchHook(repoDir);
			expect(result.status).toBe("installed-no-hookspath");
			expect(result.details).toContain(".lefthook");

			// Hook was still written
			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");
			expect(existsSync(hookPath)).toBe(true);

			// README was written
			const readmePath = resolve(repoDir, ".tff", "hooks", "README.md");
			expect(existsSync(readmePath)).toBe(true);
			const readme = readFileSync(readmePath, "utf-8");
			expect(readme).toContain(".tff/hooks/pre-push");

			// core.hooksPath was NOT changed
			const hooksPath = execSync("git config --get core.hooksPath", {
				cwd: repoDir,
				encoding: "utf-8",
				stdio: "pipe",
			}).trim();
			expect(hooksPath).toBe(".lefthook");
		});

		it("idempotent: calling twice produces same result without error", () => {
			const first = installProtectedBranchHook(repoDir);
			expect(first.status).toBe("installed");

			const second = installProtectedBranchHook(repoDir);
			expect(second.status).toBe("installed");

			// Still one file, still executable
			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");
			expect(existsSync(hookPath)).toBe(true);
			const mode = statSync(hookPath).mode;
			expect(mode & 0o111).toBeGreaterThan(0);
		});

		it("idempotent with existing TFF hooksPath: status stays installed", () => {
			installProtectedBranchHook(repoDir);
			// Simulate second startup
			const result = installProtectedBranchHook(repoDir);
			expect(result.status).toBe("installed");
		});
	});

	// ---------------------------------------------------------------------------
	// Hook script execution (functional test)
	// ---------------------------------------------------------------------------

	describe("hook script execution", () => {
		it("exits 1 and prints error message when pushing to refs/heads/main", () => {
			installProtectedBranchHook(repoDir);
			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");

			// Simulate git passing: local_ref local_sha remote_ref remote_sha
			// git push stdin format: "<local-ref> <local-sha> <remote-ref> <remote-sha>"
			const stdin = "refs/heads/feature/foo abc123 refs/heads/main def456\n";

			let caught: Error | null = null;
			let stderr = "";
			try {
				execFileSync(hookPath, [], {
					cwd: repoDir,
					input: stdin,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				caught = err as Error;
				stderr = (err as { stderr?: string }).stderr ?? "";
			}

			expect(caught).not.toBeNull();
			expect(stderr).toContain("protected branch");
			expect(stderr).toContain("main");
		});

		it("exits 1 when pushing to refs/heads/master", () => {
			installProtectedBranchHook(repoDir);
			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");

			const stdin = "refs/heads/feature/foo abc123 refs/heads/master def456\n";
			let caught: Error | null = null;
			try {
				execFileSync(hookPath, [], {
					cwd: repoDir,
					input: stdin,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				caught = err as Error;
			}
			expect(caught).not.toBeNull();
		});

		it("exits 0 when pushing to a feature branch", () => {
			installProtectedBranchHook(repoDir);
			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");

			const stdin = "refs/heads/feature/foo abc123 refs/heads/feature/my-slice def456\n";
			let threw = false;
			try {
				execFileSync(hookPath, [], {
					cwd: repoDir,
					input: stdin,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it("exits 0 for empty stdin (no refs pushed)", () => {
			installProtectedBranchHook(repoDir);
			const hookPath = resolve(repoDir, ".tff", "hooks", "pre-push");

			let threw = false;
			try {
				execFileSync(hookPath, [], {
					cwd: repoDir,
					input: "",
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// detectProtectedPush
	// ---------------------------------------------------------------------------

	describe("detectProtectedPush", () => {
		const branches = DEFAULT_PROTECTED.branches;

		it("returns null for non-push commands", () => {
			expect(detectProtectedPush("git status", branches)).toBeNull();
			expect(detectProtectedPush("git pull origin main", branches)).toBeNull();
			expect(detectProtectedPush("git fetch", branches)).toBeNull();
		});

		it("detects push to main", () => {
			expect(detectProtectedPush("git push origin main", branches)).toBe("main");
		});

		it("detects push to master", () => {
			expect(detectProtectedPush("git push origin master", branches)).toBe("master");
		});

		it("detects HEAD:main refspec", () => {
			expect(detectProtectedPush("git push origin HEAD:main", branches)).toBe("main");
		});

		it("detects HEAD:refs/heads/main", () => {
			expect(detectProtectedPush("git push origin HEAD:refs/heads/main", branches)).toBe("main");
		});

		it("does not block push to feature branches", () => {
			expect(detectProtectedPush("git push origin feature/my-slice", branches)).toBeNull();
			expect(detectProtectedPush("git push origin milestone/m01", branches)).toBeNull();
		});

		it("does not block when --no-verify is present", () => {
			expect(detectProtectedPush("git push --no-verify origin main", branches)).toBeNull();
		});

		it("does not confuse 'maintain' with 'main'", () => {
			// "maintain" ends in "ain" but the branch is "main" — word boundary check
			expect(detectProtectedPush("git push origin maintain", branches)).toBeNull();
		});

		it("handles extra flags before remote", () => {
			expect(detectProtectedPush("git push --force origin main", branches)).toBe("main");
			expect(detectProtectedPush("git push -u origin main", branches)).toBe("main");
		});

		it("works with custom branch list", () => {
			expect(detectProtectedPush("git push origin develop", ["develop", "release"])).toBe(
				"develop",
			);
			expect(detectProtectedPush("git push origin release", ["develop", "release"])).toBe(
				"release",
			);
			expect(detectProtectedPush("git push origin main", ["develop", "release"])).toBeNull();
		});
	});
});
