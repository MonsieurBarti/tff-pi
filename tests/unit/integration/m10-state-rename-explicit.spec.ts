import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStateRename } from "../../../src/commands/state-rename.js";
import type { TffContext } from "../../../src/common/context.js";
import { readRepoState } from "../../../src/common/repo-state.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { seedEnabledSettings } from "../../helpers/settings.js";
import { type TestProject, initTestProject } from "../m10/helpers.js";

function makePi() {
	const msgs: string[] = [];
	return {
		msgs,
		sendUserMessage: (s: string) => msgs.push(s),
	} as unknown as ExtensionAPI & { msgs: string[] };
}

function makeCtx(root: string): TffContext {
	return { projectRoot: root } as unknown as TffContext;
}

describe("integration: /tff state rename explicit", () => {
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

	it("user git-branch-m then /tff state rename propagates", async () => {
		execSync("git branch -m feature/renamed", { cwd: p.repo });
		expect(readRepoState(p.init.projectId)?.lastKnownCodeBranch).toBe("feature/origin");

		const pi = makePi();
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/renamed"]);

		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'", {
			cwd: p.repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(refs).toContain("tff-state/feature/renamed");
		expect(refs).not.toContain("tff-state/feature/origin");

		expect(readRepoState(p.init.projectId)?.lastKnownCodeBranch).toBe("feature/renamed");
	});
});
