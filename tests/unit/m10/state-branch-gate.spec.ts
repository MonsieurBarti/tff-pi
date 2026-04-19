import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateAtPhaseEnd, ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TestProject, initTestProject } from "./helpers.js";

describe("state-branch gate (toggle off)", () => {
	let p: TestProject;

	beforeEach(() => {
		p = initTestProject();
		// toggle is OFF by default — initTestProject does not seed settings.
	});

	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("ensureStateBranch no-ops when toggle off", async () => {
		await ensureStateBranch(p.repo, p.init.projectId);
		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toBe("");
	});

	it("commitStateAtPhaseEnd no-ops when toggle off", async () => {
		await commitStateAtPhaseEnd({
			repoRoot: p.repo,
			projectId: p.init.projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toBe("");
	});

	it("ensureStateBranch creates ref when toggle on", async () => {
		writeFileSync(
			join(p.repo, ".pi", ".tff", "settings.yaml"),
			"state_branch:\n  enabled: true\n",
			"utf-8",
		);
		await ensureStateBranch(p.repo, p.init.projectId);
		const hasLocal = execSync(
			"git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'",
			{ cwd: p.repo, encoding: "utf-8" },
		).trim();
		expect(hasLocal.startsWith("tff-state/")).toBe(true);
	});
});
