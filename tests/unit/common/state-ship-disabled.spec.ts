import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeStateBranchForMilestone } from "../../../src/common/state-ship.js";
import { type TestProject, initTestProject } from "../m10/helpers.js";

describe("finalizeStateBranchForMilestone — disabled", () => {
	let p: TestProject;
	beforeEach(() => {
		p = initTestProject(); // toggle OFF (S5 default)
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("returns 'skipped-disabled' when toggle is off", async () => {
		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: p.repo,
			projectId: p.init.projectId,
			milestoneBranch: "milestone/M01",
			parentBranch: "main",
		});
		expect(outcome).toBe("skipped-disabled");
	});
});
