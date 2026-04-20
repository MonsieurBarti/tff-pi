import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDispatch, readDispatchResult } from "../../src/common/subagent-dispatcher.js";

const EXT_DIST = pathResolve(__dirname, "..", "..", "dist", "index.js");

describe.skipIf(process.env.CI)("SubagentDispatcher — real PI smoke", () => {
	let root: string;
	beforeEach(() => {
		root = join(
			tmpdir(),
			`tff-dispatch-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(join(root, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(root, ".pi", "agents", "tff-noop.md"),
			[
				"---",
				"name: tff-noop",
				"description: noop test agent",
				"systemPromptMode: replace",
				"---",
				"Reply with exactly:",
				"STATUS: DONE",
				"EVIDENCE: noop",
				"",
			].join("\n"),
			"utf-8",
		);
		execFileSync(
			"git",
			["-c", "user.email=test@tff.local", "-c", "user.name=tff-smoke", "init", "-q"],
			{ cwd: root },
		);
		execFileSync(
			"git",
			[
				"-c",
				"user.email=test@tff.local",
				"-c",
				"user.name=tff-smoke",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"init",
				"-q",
			],
			{ cwd: root },
		);
	});
	afterEach(() => {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	});

	it("dispatches tff-noop and captures STATUS/EVIDENCE", () => {
		expect(existsSync(EXT_DIST)).toBe(true);
		const { message } = prepareDispatch(root, {
			mode: "single",
			tasks: [{ agent: "tff-noop", task: "noop", cwd: root }],
		});

		const piCmd = process.env.TFF_SMOKE_PI_CMD;
		const result = piCmd
			? spawnSync("bash", ["-lc", `${piCmd} ${JSON.stringify(message)}`], {
					cwd: root,
					encoding: "utf-8",
					timeout: 60_000,
				})
			: spawnSync("pi", ["-p", "-e", EXT_DIST, "--no-session", message], {
					cwd: root,
					encoding: "utf-8",
					timeout: 60_000,
				});
		expect(result.status).toBe(0);

		const parsed = readDispatchResult(root);
		expect(parsed).not.toBeNull();
		expect(parsed?.mode).toBe("single");
		expect(parsed?.results[0]?.status).toBe("DONE");
		expect(parsed?.results[0]?.evidence).toBe("noop");
	}, 90_000);
});
