import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateAtPhaseEnd, ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";

describe("M10-S03: phase-end is non-blocking", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
	});
	afterEach(() => fx.cleanup());

	it("does not throw when origin points at a nonexistent path", async () => {
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		execSync("git remote set-url origin /does/not/exist/origin.git", {
			cwd: fx.alice,
			stdio: "pipe",
		});
		const headBefore = execSync("git rev-parse tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		await expect(
			commitStateAtPhaseEnd({
				repoRoot: fx.alice,
				projectId: fx.aliceProjectId,
				codeBranch: "main",
				phase: "plan",
				sliceLabel: "M01-S01",
			}),
		).resolves.toBeUndefined();
		const headAfter = execSync("git rev-parse tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(headAfter).not.toBe(headBefore);
	});
});
