import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PromptDeleteRemote } from "../../../src/commands/branch-rename.js";
import { runBranchRename } from "../../../src/commands/branch-rename.js";
import type { TffContext } from "../../../src/common/context.js";
import { readRepoState } from "../../../src/common/repo-state.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";
import { type TestProject, initTestProject } from "./helpers.js";

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

describe("/tff branch rename", () => {
	let p: TestProject;

	beforeEach(async () => {
		p = initTestProject();
		seedEnabledSettings(p.repo);
		execSync("git checkout -b feature/original", { cwd: p.repo, stdio: "pipe" });
		await ensureStateBranch(p.repo, p.init.projectId);
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("renames code branch + state branch when enabled", async () => {
		const pi = makePi();
		await runBranchRename(pi, makeCtx(p.repo), null, ["feature/renamed"]);
		const head = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(head).toBe("feature/renamed");
		const stateBranches = execSync(
			"git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'",
			{ cwd: p.repo, encoding: "utf-8" },
		)
			.trim()
			.split("\n");
		expect(stateBranches).toContain("tff-state/feature/renamed");
		const rs = readRepoState(p.init.projectId);
		expect(rs?.lastKnownCodeBranch).toBe("feature/renamed");
	});

	it("does code-branch rename only when toggle disabled", async () => {
		writeFileSync(
			join(p.repo, ".pi", ".tff", "settings.yaml"),
			"state_branch:\n  enabled: false\n",
			"utf-8",
		);
		const pi = makePi();
		await runBranchRename(pi, makeCtx(p.repo), null, ["feature/renamed-disabled"]);
		const head = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(head).toBe("feature/renamed-disabled");
		// Old state branch for "feature/original" remains — we didn't touch it
		const stateBranches = execSync(
			"git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'",
			{ cwd: p.repo, encoding: "utf-8" },
		).trim();
		expect(stateBranches).toContain("tff-state/feature/original");
	});

	it("rejects invalid branch names", async () => {
		const pi = makePi();
		await runBranchRename(pi, makeCtx(p.repo), null, ["bad name"]);
		expect(pi.msgs.join("\n")).toMatch(/invalid/i);
	});
});

// ─── Remote-delete prompt tests ───────────────────────────────────────────────

function makePrompt(reply: "Yes" | "No" | "skip"): PromptDeleteRemote {
	return async (_uiCtx, _oldBranch) => reply;
}

function remoteBranchList(origin: string): string[] {
	return execSync("git for-each-ref refs/heads/ --format='%(refname:short)'", {
		cwd: origin,
		encoding: "utf-8",
	})
		.trim()
		.split("\n")
		.filter(Boolean);
}

describe("/tff branch rename — remote-delete prompt", () => {
	let tc: Awaited<ReturnType<typeof makeTwoClone>>;

	beforeEach(async () => {
		tc = await makeTwoClone();
		seedEnabledSettings(tc.alice);
		// Create and push the branch we will rename
		execSync("git checkout -b feature/original", { cwd: tc.alice, stdio: "pipe" });
		execSync("git push -u origin feature/original", { cwd: tc.alice, stdio: "pipe" });
	});

	afterEach(() => {
		tc.cleanup();
		if (tc.savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = tc.savedTffHome;
		for (const [k, v] of Object.entries(tc.savedGit)) {
			if (v !== undefined) process.env[k] = v;
		}
	});

	it("deletes old remote branch when prompt returns Yes", async () => {
		const pi = makePi();
		await runBranchRename(pi, makeCtx(tc.alice), null, ["feature/renamed"], {
			promptDeleteRemote: makePrompt("Yes"),
		});

		const refs = remoteBranchList(tc.origin);
		expect(refs).not.toContain("feature/original");
		expect(refs).toContain("feature/renamed");
		expect(pi.msgs.join("\n")).toMatch(/Deleted origin\/feature\/original/);
	});

	it("preserves old remote branch when prompt returns No", async () => {
		const pi = makePi();
		await runBranchRename(pi, makeCtx(tc.alice), null, ["feature/renamed"], {
			promptDeleteRemote: makePrompt("No"),
		});

		const refs = remoteBranchList(tc.origin);
		expect(refs).toContain("feature/original");
		expect(refs).toContain("feature/renamed");
		expect(pi.msgs.join("\n")).toMatch(/Left origin\/feature\/original in place \(user declined\)/);
	});

	it("preserves old remote branch when headless (prompt returns skip)", async () => {
		const pi = makePi();
		// null uiCtx simulates headless; we also inject skip via the seam to confirm
		await runBranchRename(pi, makeCtx(tc.alice), null, ["feature/renamed"], {
			promptDeleteRemote: makePrompt("skip"),
		});

		const refs = remoteBranchList(tc.origin);
		expect(refs).toContain("feature/original");
		expect(refs).toContain("feature/renamed");
		expect(pi.msgs.join("\n")).toMatch(/Left origin\/feature\/original in place \(headless/);
	});
});
