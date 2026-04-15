import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeStateBranchForMilestone } from "../../../src/common/state-ship.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";

describe("finalizeStateBranchForMilestone", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
	});
	afterEach(() => fx.cleanup());

	it("returns 'skipped-no-state-branch' when no tff-state/<milestoneBranch> exists", async () => {
		// milestone branch exists as a code branch but no state branch for it
		execFileSync("git", ["checkout", "-b", "milestone/M99"], { cwd: fx.alice, stdio: "pipe" });
		execFileSync("git", ["commit", "--allow-empty", "-m", "milestone init"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		execFileSync("git", ["checkout", "main"], { cwd: fx.alice, stdio: "pipe" });

		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch: "milestone/M99",
			parentBranch: "main",
		});

		expect(outcome).toBe("skipped-no-state-branch");
	});
});
