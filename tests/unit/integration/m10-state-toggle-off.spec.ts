import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateAtPhaseEnd, ensureStateBranch } from "../../../src/common/state-branch.js";
import { finalizeStateBranchForMilestone } from "../../../src/common/state-ship.js";
import { type TestProject, initTestProject } from "../m10/helpers.js";

describe("integration: state toggle off end-to-end", () => {
	let p: TestProject;
	beforeEach(() => {
		p = initTestProject(); // toggle OFF by default
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("full slice run creates no tff-state refs or repo-state.json", async () => {
		await ensureStateBranch(p.repo, p.init.projectId);
		for (const phase of ["plan", "research", "execute", "verify"] as const) {
			await commitStateAtPhaseEnd({
				repoRoot: p.repo,
				projectId: p.init.projectId,
				codeBranch: "main",
				phase,
				sliceLabel: "M01-S01",
			});
		}
		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: p.repo,
			projectId: p.init.projectId,
			milestoneBranch: "milestone/M01",
			parentBranch: "main",
		});
		expect(outcome).toBe("skipped-disabled");

		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toBe("");

		const repoStatePath = join(p.home, p.init.projectId, "repo-state.json");
		expect(existsSync(repoStatePath)).toBe(false);
	});
});
