import { execSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStateRename } from "../../../src/commands/state-rename.js";
import type { TffContext } from "../../../src/common/context.js";
import { readRepoState, writeRepoState } from "../../../src/common/repo-state.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { seedEnabledSettings } from "../../helpers/settings.js";
import { type TestProject, initTestProject } from "./helpers.js";

function makePi() {
	const messages: string[] = [];
	return {
		messages,
		sendUserMessage: (s: string) => messages.push(s),
	} as unknown as Parameters<typeof runStateRename>[0] & { messages: string[] };
}

function makeCtx(root: string): TffContext {
	return { projectRoot: root } as unknown as TffContext;
}

describe("/tff state rename", () => {
	let p: TestProject;
	let pi: ReturnType<typeof makePi>;

	beforeEach(async () => {
		p = initTestProject();
		seedEnabledSettings(p.repo);
		await ensureStateBranch(p.repo, p.init.projectId);
		pi = makePi();
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("errors when toggle disabled", async () => {
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: false\n",
			"utf-8",
		);
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/new"]);
		expect(pi.messages.join("\n")).toMatch(/state branch.*disabled/i);
	});

	it("errors when no prior repo-state", async () => {
		unlinkSync(join(p.home, p.init.projectId, "repo-state.json"));
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/new"]);
		expect(pi.messages.join("\n")).toMatch(/no prior state|no lastKnownCodeBranch/i);
	});

	it("happy path renames local state branch and updates repo-state", async () => {
		const rs = readRepoState(p.init.projectId);
		if (!rs) throw new Error("expected repo-state to exist after ensureStateBranch");
		const oldState = `tff-state/${rs.lastKnownCodeBranch}`;
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/renamed"]);
		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'", {
			cwd: p.repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(refs).toContain("tff-state/feature/renamed");
		expect(refs).not.toContain(oldState);
		const after = readRepoState(p.init.projectId);
		expect(after?.lastKnownCodeBranch).toBe("feature/renamed");
	});

	it("errors when destination state branch already exists", async () => {
		execSync("git branch tff-state/feature/existing", { cwd: p.repo });
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/existing"]);
		expect(pi.messages.join("\n")).toMatch(/destination.*exists/i);
	});

	it("rejects invalid branch names", async () => {
		await runStateRename(pi, makeCtx(p.repo), null, ["bad name;rm"]);
		expect(pi.messages.join("\n")).toMatch(/invalid/i);
	});

	it("idempotent: rerun with same name after rename is no-op", async () => {
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/renamed"]);
		pi.messages.length = 0;
		writeRepoState(p.init.projectId, { lastKnownCodeBranch: "feature/renamed" });
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/renamed"]);
		expect(pi.messages.join("\n")).not.toMatch(/error|failed/i);
	});

	it("accepts sourceCodeBranch override (used by /tff branch rename)", async () => {
		// Read the current source branch from repo-state before we corrupt it.
		const rs = readRepoState(p.init.projectId);
		if (!rs) throw new Error("expected repo-state to exist after ensureStateBranch");
		const originalLast = rs.lastKnownCodeBranch;

		// Overwrite repo-state with a wrong value to prove the override wins.
		writeRepoState(p.init.projectId, { lastKnownCodeBranch: "feature/wrong-branch" });

		await runStateRename(pi, makeCtx(p.repo), null, ["feature/renamed"], {
			sourceCodeBranch: originalLast,
		});

		expect(pi.messages.join("\n")).not.toMatch(/error|failed/i);
		const after = readRepoState(p.init.projectId);
		expect(after?.lastKnownCodeBranch).toBe("feature/renamed");
	});

	it("rejects invalid sourceCodeBranch in opts", async () => {
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/new"], {
			sourceCodeBranch: "bad name;rm",
		});
		expect(pi.messages.join("\n")).toMatch(/invalid sourceCodeBranch/i);
	});
});
