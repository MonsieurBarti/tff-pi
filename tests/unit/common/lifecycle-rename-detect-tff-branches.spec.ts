import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeRepoState } from "../../../src/common/repo-state.js";
import { detectRenameAlert } from "../../../src/lifecycle-rename-detect.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("detectRenameAlert — TFF-managed branches", () => {
	let tmp: string;
	let projectId: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tff-rdetect-"));
		execFileSync("git", ["init", "-q", "-b", "main", tmp]);
		execFileSync("git", ["-C", tmp, "config", "user.email", "t@x"]);
		execFileSync("git", ["-C", tmp, "config", "user.name", "t"]);
		execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"]);
		seedEnabledSettings(tmp);
		// readProjectIdFile validates UUID v4; use a real one (the worktree-uuid-branch.spec
		// did the same fix in T3).
		projectId = "11111111-2222-4333-8444-555555555555";
		mkdirSync(join(tmp, ".pi", ".tff"), { recursive: true });
		writeFileSync(join(tmp, ".tff-project-id"), projectId);
		// Ensure ~/.tff/<projectId> exists for repo-state writes
		const tffDir = join(homedir(), ".tff", projectId);
		mkdirSync(tffDir, { recursive: true });
		writeRepoState(projectId, { lastKnownCodeBranch: "main" });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		// Clean up ~/.tff/<projectId> if it exists
		const tffDir = join(homedir(), ".tff", projectId);
		rmSync(tffDir, { recursive: true, force: true });
	});

	it("does not alert when HEAD is on a slice/* branch", async () => {
		// Simulate a scenario where the old code branch was deleted/doesn't exist,
		// and we're now on a slice/* branch. Without the guard, this would alert.
		execFileSync("git", ["-C", tmp, "checkout", "-b", "my-feature"]);
		execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "work"]);
		writeRepoState(projectId, { lastKnownCodeBranch: "my-feature" });
		// Now switch to a slice branch and delete the old feature branch to simulate a rename
		execFileSync("git", ["-C", tmp, "checkout", "-b", "slice/abc12345"]);
		execFileSync("git", ["-C", tmp, "branch", "-D", "my-feature"]);
		const emit = vi.fn();
		const result = await detectRenameAlert(tmp, projectId, emit);
		expect(emit).not.toHaveBeenCalled();
		expect(result).toBe("not-a-rename");
	});

	it("does not alert when HEAD is on a milestone/* branch", async () => {
		// Simulate a scenario where the old code branch was deleted/doesn't exist,
		// and we're now on a milestone/* branch. Without the guard, this would alert.
		execFileSync("git", ["-C", tmp, "checkout", "-b", "my-feature"]);
		execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "work"]);
		writeRepoState(projectId, { lastKnownCodeBranch: "my-feature" });
		// Now switch to a milestone branch and delete the old feature branch to simulate a rename
		execFileSync("git", ["-C", tmp, "checkout", "-b", "milestone/abc12345"]);
		execFileSync("git", ["-C", tmp, "branch", "-D", "my-feature"]);
		const emit = vi.fn();
		const result = await detectRenameAlert(tmp, projectId, emit);
		expect(emit).not.toHaveBeenCalled();
		expect(result).toBe("not-a-rename");
	});
});
