import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	commitStateAtPhaseEnd,
	ensureStateBranch,
	pushWithRebaseRetry,
} from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("M10-S03: multi-machine unresolvable conflict", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});
	afterEach(() => fx.cleanup());

	it("creates tff-state/main--conflict-<ts> and force-pushes local", async () => {
		// Alice sets up state branch, writes settings.yaml (non-JSON), commits + pushes
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		writeFileSync(
			join(fx.home, fx.aliceProjectId, "settings.yaml"),
			"state_branch:\n  enabled: true\nownedBy: alice\n",
		);
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		execSync("git checkout tff-state/main", { cwd: fx.alice, stdio: "pipe" });
		await pushWithRebaseRetry(fx.alice, "tff-state/main");
		execSync("git checkout main", { cwd: fx.alice, stdio: "pipe" });

		// Bob fetches state branch, writes conflicting settings.yaml, commits
		execSync("git fetch origin tff-state/main:tff-state/main", { cwd: fx.bob, stdio: "pipe" });
		writeFileSync(
			join(fx.home, fx.bobProjectId, "settings.yaml"),
			"state_branch:\n  enabled: true\nownedBy: bob\n",
		);
		await commitStateAtPhaseEnd({
			repoRoot: fx.bob,
			projectId: fx.bobProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M02-S01",
		});
		execSync("git checkout tff-state/main", { cwd: fx.bob, stdio: "pipe" });

		// Alice writes another conflicting settings.yaml change and pushes again
		writeFileSync(
			join(fx.home, fx.aliceProjectId, "settings.yaml"),
			"state_branch:\n  enabled: true\nownedBy: alice-v2\n",
		);
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M03-S01",
		});
		execSync("git checkout tff-state/main", { cwd: fx.alice, stdio: "pipe" });
		await pushWithRebaseRetry(fx.alice, "tff-state/main");
		execSync("git checkout main", { cwd: fx.alice, stdio: "pipe" });

		// Bob tries to push — rebase of settings.yaml conflicts → backup branch
		// The backup branch uses double-dash: tff-state/main--conflict-<ts>
		const outcome = await pushWithRebaseRetry(fx.bob, "tff-state/main");
		expect(outcome).toBe("conflict-backup");
		const remoteBranches = execSync(
			`git -C ${fx.origin} branch --list "tff-state/main--conflict-*"`,
			{ encoding: "utf-8" },
		);
		expect(remoteBranches).toMatch(/tff-state\/main--conflict-/);

		// Verify bob's settings.yaml (conflict-winning local state) is on origin
		execSync("git fetch origin tff-state/main:tff-state/main -f", {
			cwd: fx.alice,
			stdio: "pipe",
		});
		const postFetch = execSync("git show origin/tff-state/main:settings.yaml", {
			cwd: fx.alice,
			encoding: "utf-8",
		});
		expect(postFetch).toContain("bob");
	});
});
