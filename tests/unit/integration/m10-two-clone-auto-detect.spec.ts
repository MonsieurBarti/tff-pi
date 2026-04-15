import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoState, writeRepoState } from "../../../src/common/repo-state.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { detectRenameAlert } from "../../../src/lifecycle-rename-detect.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("integration: two-clone auto-detect on rename", () => {
	let fx: TwoClone;

	beforeEach(async () => {
		fx = await makeTwoClone();
		// makeTwoClone already calls handleInit on both alice and bob, so
		// aliceProjectId and bobProjectId are set. Seed enabled settings in both
		// working copies.
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});

	afterEach(() => {
		fx.cleanup();
	});

	it("Alice renames; Bob preflight surfaces alert and records current branch", async () => {
		// Alice: create feature/alpha and ensure the state branch locally.
		// We do NOT push the state branch to origin so that git ls-remote on Bob's
		// side does not match "feature/alpha" via the tff-state/feature/alpha ref
		// (git ls-remote pattern matching is a suffix match, so pushing
		// tff-state/feature/alpha would cause remoteBranchExists("feature/alpha")
		// to return true, preventing the alert).
		execSync("git checkout -b feature/alpha", { cwd: fx.alice, stdio: "pipe" });
		await ensureStateBranch(fx.alice, fx.aliceProjectId);

		// Alice renames the code branch locally. The state branch is intentionally
		// NOT renamed here — that is the scenario we want Bob's preflight to detect.
		execSync("git branch -m feature/alpha-renamed", { cwd: fx.alice, stdio: "pipe" });

		// Bob: set up as if Bob had previously worked on feature/alpha. We write
		// repo-state directly to avoid triggering ensureStateBranch's orphan-branch
		// creation (which would require git-worktree setup on a fresh clone).
		execSync("git checkout -b feature/alpha", { cwd: fx.bob, stdio: "pipe" });
		writeRepoState(fx.bobProjectId, { lastKnownCodeBranch: "feature/alpha" });

		// Bob switches to feature/alpha-renamed (the renamed name), as if the user
		// ran `git branch -m feature/alpha-renamed` on Bob's machine.
		execSync("git branch -m feature/alpha-renamed", { cwd: fx.bob, stdio: "pipe" });

		// Verify precondition: Bob's repo-state still says "feature/alpha" and
		// feature/alpha does not exist locally or on origin.
		expect(readRepoState(fx.bobProjectId)?.lastKnownCodeBranch).toBe("feature/alpha");

		// Auto-detect runs (simulates session_start preflight on Bob's side).
		const emitted: string[] = [];
		const result = await detectRenameAlert(fx.bob, fx.bobProjectId, (msg) => emitted.push(msg));

		// feature/alpha no longer exists locally or on origin, so auto-detect
		// should classify this as a true rename and alert.
		expect(result).toBe("alerted");
		expect(emitted.join("\n")).toMatch(
			/Detected branch rename: feature\/alpha -> feature\/alpha-renamed/,
		);

		// Bob's repo-state is updated so the alert does not re-fire next session.
		expect(readRepoState(fx.bobProjectId)?.lastKnownCodeBranch).toBe("feature/alpha-renamed");
	});

	it("skips alert when old branch still exists somewhere (not a true rename)", async () => {
		// Bob starts on feature/beta, records repo-state, then switches to main.
		// feature/beta still exists locally, so branchExistsAnywhere returns true
		// and detectRenameAlert should return "not-a-rename".
		execSync("git checkout -b feature/beta", { cwd: fx.bob, stdio: "pipe" });
		writeRepoState(fx.bobProjectId, { lastKnownCodeBranch: "feature/beta" });

		// Switch to main WITHOUT deleting feature/beta.
		execSync("git checkout main", { cwd: fx.bob, stdio: "pipe" });

		const emitted: string[] = [];
		const result = await detectRenameAlert(fx.bob, fx.bobProjectId, (msg) => emitted.push(msg));

		expect(result).toBe("not-a-rename");
		expect(emitted).toHaveLength(0);
		// Repo-state is updated to current branch.
		expect(readRepoState(fx.bobProjectId)?.lastKnownCodeBranch).toBe("main");
	});
});
