import { execSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { ProjectHomeError, isUuidV4 } from "../../../src/common/project-home.js";

describe("handleInit", () => {
	let repo: string;
	let home: string;
	const savedGitEnv: Record<string, string | undefined> = {};
	const savedTffHome = process.env.TFF_HOME;

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				Reflect.deleteProperty(process.env, key);
			}
		}
		repo = mkdtempSync(join(tmpdir(), "tff-init-repo-"));
		home = mkdtempSync(join(tmpdir(), "tff-init-home-"));
		process.env.TFF_HOME = home;
		execSync("git init", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("on a fresh repo: generates UUID, creates home, symlink, and .tff-project-id", () => {
		const result = handleInit(repo);
		expect(result.created).toBe(true);
		expect(isUuidV4(result.projectId)).toBe(true);
		expect(result.projectHome).toBe(join(home, result.projectId));
		expect(existsSync(join(home, result.projectId))).toBe(true);
		expect(existsSync(join(home, result.projectId, "milestones"))).toBe(true);
		expect(lstatSync(join(repo, ".tff")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(repo, ".tff-project-id"), "utf-8").trim()).toBe(result.projectId);
	});

	it("on re-run: returns same projectId with created=false", () => {
		const first = handleInit(repo);
		const second = handleInit(repo);
		expect(second.projectId).toBe(first.projectId);
		expect(second.created).toBe(false);
	});

	it("throws ProjectHomeError when .tff/ is a real directory", () => {
		mkdirSync(join(repo, ".tff"), { recursive: true });
		expect(() => handleInit(repo)).toThrow(ProjectHomeError);
	});

	it("throws ProjectHomeError when .tff-project-id is corrupt", () => {
		writeFileSync(join(repo, ".tff-project-id"), "garbage\n");
		expect(() => handleInit(repo)).toThrow(ProjectHomeError);
	});

	it("recovers when ~/.tff/{id}/ was deleted: re-creates home, keeps id", () => {
		const first = handleInit(repo);
		rmSync(first.projectHome, { recursive: true, force: true });
		rmSync(join(repo, ".tff"));
		const second = handleInit(repo);
		expect(second.projectId).toBe(first.projectId);
		expect(second.created).toBe(false);
		expect(existsSync(first.projectHome)).toBe(true);
		expect(lstatSync(join(repo, ".tff")).isSymbolicLink()).toBe(true);
	});

	it("throws on Windows", () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(() => handleInit(repo)).toThrow(/Windows support lands in M11/);
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		}
	});
});
