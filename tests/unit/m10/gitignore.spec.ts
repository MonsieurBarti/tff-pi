import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignoreEntries } from "../../../src/common/git.js";

describe("ensureGitignoreEntries", () => {
	let repo: string;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Clear GIT_* env vars (lefthook context leakage)
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-gitignore-"));
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("creates .gitignore with /.tff and standard TFF entries when absent", () => {
		ensureGitignoreEntries(repo);
		const content = readFileSync(join(repo, ".gitignore"), "utf-8");
		expect(content).toContain("/.tff\n");
		expect(content).toContain(".pi/");
		expect(content).toContain("node_modules/");
	});

	it("is idempotent — re-running does not duplicate lines", () => {
		ensureGitignoreEntries(repo);
		const first = readFileSync(join(repo, ".gitignore"), "utf-8");
		ensureGitignoreEntries(repo);
		const second = readFileSync(join(repo, ".gitignore"), "utf-8");
		expect(second).toBe(first);
	});

	it("preserves existing user entries", () => {
		writeFileSync(join(repo, ".gitignore"), "my-secret\n");
		ensureGitignoreEntries(repo);
		const content = readFileSync(join(repo, ".gitignore"), "utf-8");
		expect(content).toContain("my-secret");
		expect(content).toContain("/.tff");
	});

	it("does not include .tff-project-id (tracked file)", () => {
		ensureGitignoreEntries(repo);
		const content = readFileSync(join(repo, ".gitignore"), "utf-8");
		expect(content).not.toMatch(/^\.tff-project-id\s*$/m);
	});
});
