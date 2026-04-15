import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBranchRename } from "../../../src/commands/branch-rename.js";
import { runStateRename } from "../../../src/commands/state-rename.js";
import type { TffContext } from "../../../src/common/context.js";
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

describe("integration: rename when toggle disabled", () => {
	let p: TestProject;
	beforeEach(() => {
		p = initTestProject(); // toggle OFF
		execSync("git checkout -b feature/old", { cwd: p.repo });
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("/tff state rename errors with disabled message", async () => {
		const pi = makePi();
		await runStateRename(pi, makeCtx(p.repo), null, ["feature/new"]);
		expect(pi.msgs.join("\n")).toMatch(/disabled/i);
	});

	it("/tff branch rename does git branch -m, skips state", async () => {
		const pi = makePi();
		await runBranchRename(pi, makeCtx(p.repo), null, ["feature/new"]);

		const head = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(head).toBe("feature/new");

		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toBe("");
	});
});
