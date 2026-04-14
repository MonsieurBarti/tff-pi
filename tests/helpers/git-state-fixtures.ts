// tests/helpers/git-state-fixtures.ts
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInit } from "../../src/commands/init.js";

export interface TwoClone {
	home: string;
	origin: string;
	alice: string;
	bob: string;
	aliceProjectId: string;
	bobProjectId: string;
	cleanup: () => void;
	savedTffHome: string | undefined;
	savedGit: Record<string, string | undefined>;
}

export async function makeTwoClone(): Promise<TwoClone> {
	const savedGit: Record<string, string | undefined> = {};
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("GIT_")) {
			savedGit[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
	}
	const savedTffHome = process.env.TFF_HOME;

	const home = mkdtempSync(join(tmpdir(), "tff-s3-home-"));
	const origin = mkdtempSync(join(tmpdir(), "tff-s3-origin-"));
	const alice = mkdtempSync(join(tmpdir(), "tff-s3-alice-"));
	const bob = mkdtempSync(join(tmpdir(), "tff-s3-bob-"));
	process.env.TFF_HOME = home;

	execSync("git init --bare -b main", { cwd: origin, stdio: "pipe" });

	execSync("git init -b main", { cwd: alice, stdio: "pipe" });
	execSync('git config user.email "a@a.com"', { cwd: alice, stdio: "pipe" });
	execSync('git config user.name "A"', { cwd: alice, stdio: "pipe" });
	execSync("git commit --allow-empty -m 'initial'", { cwd: alice, stdio: "pipe" });
	execSync(`git remote add origin ${origin}`, { cwd: alice, stdio: "pipe" });
	const aliceRes = handleInit(alice);
	execSync("git add -A", { cwd: alice, stdio: "pipe" });
	execSync("git commit -m 'chore: init tff'", { cwd: alice, stdio: "pipe" });
	execSync("git push -u origin main", { cwd: alice, stdio: "pipe" });

	execSync(`git clone ${origin} ${bob}`, { stdio: "pipe" });
	execSync('git config user.email "b@b.com"', { cwd: bob, stdio: "pipe" });
	execSync('git config user.name "B"', { cwd: bob, stdio: "pipe" });
	const bobRes = handleInit(bob);

	const cleanup = () => {
		rmSync(home, { recursive: true, force: true });
		rmSync(origin, { recursive: true, force: true });
		rmSync(alice, { recursive: true, force: true });
		rmSync(bob, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [k, v] of Object.entries(savedGit)) if (v !== undefined) process.env[k] = v;
	};

	return {
		home,
		origin,
		alice,
		bob,
		aliceProjectId: aliceRes.projectId,
		bobProjectId: bobRes.projectId,
		cleanup,
		savedTffHome,
		savedGit,
	};
}

export function readProjectId(repoRoot: string): string {
	return readFileSync(join(repoRoot, ".tff-project-id"), "utf-8").trim();
}
