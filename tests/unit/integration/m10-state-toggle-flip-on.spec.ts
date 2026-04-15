import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateAtPhaseEnd, ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TestProject, initTestProject } from "../m10/helpers.js";

describe("integration: toggle flip-on mid-project", () => {
	let p: TestProject;
	beforeEach(() => {
		p = initTestProject();
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("no refs created while off; lazy-fork happens after flip", async () => {
		// Off by default — no refs
		await ensureStateBranch(p.repo, p.init.projectId);
		await commitStateAtPhaseEnd({
			repoRoot: p.repo,
			projectId: p.init.projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		let refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toBe("");

		// Flip on
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: true\n",
			"utf-8",
		);

		// Re-run ensure; should lazy-fork now
		await ensureStateBranch(p.repo, p.init.projectId);
		refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toContain("tff-state/");
	});
});
