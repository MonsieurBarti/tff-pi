import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleInit } from "../../../src/commands/init.js";

describe("m10-s1 — multi-project under single TFF_HOME", () => {
	let home: string;
	let repoA: string;
	let repoB: string;
	const savedTffHome = process.env.TFF_HOME;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		home = mkdtempSync(join(tmpdir(), "tff-multi-home-"));
		repoA = mkdtempSync(join(tmpdir(), "tff-multi-A-"));
		repoB = mkdtempSync(join(tmpdir(), "tff-multi-B-"));
		process.env.TFF_HOME = home;
		for (const r of [repoA, repoB]) {
			execSync("git init", { cwd: r, stdio: "pipe" });
			execSync('git config user.email "t@t.com"', { cwd: r, stdio: "pipe" });
			execSync('git config user.name "T"', { cwd: r, stdio: "pipe" });
		}
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(repoA, { recursive: true, force: true });
		rmSync(repoB, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("two separate repos get two isolated project homes under the same TFF_HOME", () => {
		const a = handleInit(repoA);
		const b = handleInit(repoB);

		expect(a.projectId).not.toBe(b.projectId);
		expect(a.projectHome).toBe(join(home, a.projectId));
		expect(b.projectHome).toBe(join(home, b.projectId));

		expect(readlinkSync(join(repoA, ".tff"))).toBe(a.projectHome);
		expect(readlinkSync(join(repoB, ".tff"))).toBe(b.projectHome);

		expect(existsSync(join(a.projectHome, "state.db"))).toBe(true);
		expect(existsSync(join(b.projectHome, "state.db"))).toBe(true);
	});

	it("deleting one project's home does not affect the other", () => {
		const a = handleInit(repoA);
		const b = handleInit(repoB);
		rmSync(a.projectHome, { recursive: true, force: true });
		expect(existsSync(b.projectHome)).toBe(true);
		expect(existsSync(join(b.projectHome, "state.db"))).toBe(true);
	});
});
