import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InitResult, handleInit } from "../../../src/commands/init.js";

export interface TestProject {
	repo: string;
	home: string;
	init: InitResult;
	cleanup: () => void;
	restoreEnv: () => void;
}

/**
 * Create an isolated TFF-initialized git repo for tests.
 * Sets TFF_HOME to a per-project tmpdir; caller must call restoreEnv() in afterEach.
 */
export function initTestProject(): TestProject {
	const savedTffHome = process.env.TFF_HOME;
	const savedGitEnv: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) {
			savedGitEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
	}

	const repo = mkdtempSync(join(tmpdir(), "tff-test-repo-"));
	const home = mkdtempSync(join(tmpdir(), "tff-test-home-"));
	process.env.TFF_HOME = home;

	execSync("git init", { cwd: repo, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', { cwd: repo, stdio: "pipe" });
	execSync('git config user.name "Test"', { cwd: repo, stdio: "pipe" });
	execSync("git commit --allow-empty -m 'init'", { cwd: repo, stdio: "pipe" });

	const init = handleInit(repo);

	return {
		repo,
		home,
		init,
		cleanup: () => {
			rmSync(repo, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		},
		restoreEnv: () => {
			if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
			else process.env.TFF_HOME = savedTffHome;
			for (const [key, value] of Object.entries(savedGitEnv)) {
				if (value !== undefined) process.env[key] = value;
			}
		},
	};
}
