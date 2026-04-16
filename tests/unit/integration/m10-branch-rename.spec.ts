import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBranchRename } from "../../../src/commands/branch-rename.js";
import type { TffContext } from "../../../src/common/context.js";
import { readRepoState } from "../../../src/common/repo-state.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { seedEnabledSettings } from "../../helpers/settings.js";
import { type TestProject, initTestProject } from "../m10/helpers.js";

function makeSetup() {
	const msgs: string[] = [];
	const pi = {
		msgs,
		sendUserMessage: (s: string) => msgs.push(s),
	} as unknown as ExtensionAPI & { msgs: string[] };
	return { pi };
}

function makeCtx(root: string): TffContext {
	return { projectRoot: root } as unknown as TffContext;
}

describe("integration: /tff branch rename", () => {
	let p: TestProject;

	beforeEach(async () => {
		p = initTestProject();
		seedEnabledSettings(p.repo);
		execSync("git checkout -b feature/origin", { cwd: p.repo });
		await ensureStateBranch(p.repo, p.init.projectId);
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("one-shot renames code + state + updates repo-state", async () => {
		const { pi } = makeSetup();
		await runBranchRename(pi, makeCtx(p.repo), null, ["feature/renamed"]);

		const head = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(head).toBe("feature/renamed");

		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'", {
			cwd: p.repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(refs).toContain("tff-state/feature/renamed");

		expect(readRepoState(p.init.projectId)?.lastKnownCodeBranch).toBe("feature/renamed");
	});
});
