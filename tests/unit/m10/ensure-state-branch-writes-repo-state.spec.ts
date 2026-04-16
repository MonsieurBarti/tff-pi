import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoState } from "../../../src/common/repo-state.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TestProject, initTestProject } from "./helpers.js";

describe("ensureStateBranch writes repo-state.json", () => {
	let p: TestProject;
	beforeEach(() => {
		p = initTestProject();
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: true\n",
			"utf-8",
		);
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("records current code branch after fork", async () => {
		await ensureStateBranch(p.repo, p.init.projectId);
		const rs = readRepoState(p.init.projectId);
		expect(rs?.lastKnownCodeBranch).toBeDefined();
		expect((rs?.lastKnownCodeBranch ?? "").length).toBeGreaterThan(0);
	});
});
