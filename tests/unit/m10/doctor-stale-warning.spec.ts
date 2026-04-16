import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../../src/commands/doctor.js";
import type { TffContext } from "../../../src/common/context.js";
import { openDatabase } from "../../../src/common/db.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TestProject, initTestProject } from "./helpers.js";

describe("/tff doctor stale state-branch warning", () => {
	let p: TestProject;
	let db: import("better-sqlite3").Database;

	beforeEach(async () => {
		p = initTestProject();

		// Enable, create a state branch, then disable — leaves stale ref
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: true\n",
			"utf-8",
		);
		await ensureStateBranch(p.repo, p.init.projectId);
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: false\n",
			"utf-8",
		);

		db = openDatabase(join(p.init.projectHome, "state.db"));
	});

	afterEach(() => {
		db.close();
		p.cleanup();
		p.restoreEnv();
	});

	it("doctor surfaces stale refs when enabled=false", async () => {
		const msgs: string[] = [];
		const pi = {
			sendUserMessage: (s: string) => msgs.push(s),
		} as unknown as ExtensionAPI;
		const ctx = {
			db,
			projectRoot: p.repo,
			settings: null,
			fffBridge: null,
			eventLogger: null,
			toolCallLogger: null,
			tuiMonitor: null,
			cmdCtx: null,
			initError: null,
		} as unknown as TffContext;
		await runDoctor(pi, ctx, null, []);
		expect(msgs.join("\n")).toMatch(/state_branch is disabled.*stale.*tff-state/is);
	});
});
