import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { applyMigrations, insertProject, openDatabase } from "../../../src/common/db.js";
import {
	StateBranchError,
	commitStateAtPhaseEnd,
	ensureStateBranch,
	mirrorPortableSubset,
	stateBranchName,
} from "../../../src/common/state-branch.js";

describe("stateBranchName", () => {
	it("prefixes with tff-state/", () => {
		expect(stateBranchName("main")).toBe("tff-state/main");
	});
	it("preserves slashes in code branch names", () => {
		expect(stateBranchName("feature/M10")).toBe("tff-state/feature/M10");
	});
	it("handles ticket-style names (mb/lin-1234)", () => {
		expect(stateBranchName("mb/lin-1234-portable-state")).toBe(
			"tff-state/mb/lin-1234-portable-state",
		);
	});
});

describe("StateBranchError", () => {
	it("has a .name of StateBranchError", () => {
		const e = new StateBranchError("boom");
		expect(e.name).toBe("StateBranchError");
		expect(e).toBeInstanceOf(Error);
	});
});

describe("mirrorPortableSubset", () => {
	let home: string;
	let work: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sb-home-"));
		work = mkdtempSync(join(tmpdir(), "sb-work-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	it("copies settings.yaml and milestones/**/*.md", () => {
		writeFileSync(join(home, "settings.yaml"), "k: v\n");
		mkdirSync(join(home, "milestones", "M01", "slices", "M01-S01"), { recursive: true });
		writeFileSync(join(home, "milestones", "M01", "slices", "M01-S01", "plan.md"), "# plan\n");
		mirrorPortableSubset(home, work);
		expect(readFileSync(join(work, "settings.yaml"), "utf-8")).toBe("k: v\n");
		expect(
			readFileSync(join(work, "milestones", "M01", "slices", "M01-S01", "plan.md"), "utf-8"),
		).toBe("# plan\n");
	});

	it("excludes state.db, logs/, session.lock, .tmp/, worktrees/, repo-path, repo-state.json, .gitconfig, pending-phase-message.txt", () => {
		writeFileSync(join(home, "state.db"), "binary");
		writeFileSync(join(home, "state.db-wal"), "wal");
		mkdirSync(join(home, "logs"), { recursive: true });
		writeFileSync(join(home, "logs", "M01-S01.jsonl"), "{}\n");
		writeFileSync(join(home, "session.lock"), "{}");
		mkdirSync(join(home, ".tmp"), { recursive: true });
		writeFileSync(join(home, ".tmp", "x"), "x");
		mkdirSync(join(home, "worktrees"), { recursive: true });
		writeFileSync(join(home, "worktrees", "wt"), "wt");
		writeFileSync(join(home, "repo-path"), "/x");
		writeFileSync(join(home, "repo-state.json"), "{}");
		writeFileSync(join(home, ".gitconfig"), "[x]");
		writeFileSync(join(home, "pending-phase-message.txt"), "hi");
		mirrorPortableSubset(home, work);
		for (const f of [
			"state.db",
			"state.db-wal",
			"logs",
			"session.lock",
			".tmp",
			"worktrees",
			"repo-path",
			"repo-state.json",
			".gitconfig",
			"pending-phase-message.txt",
		]) {
			expect(() => readFileSync(join(work, f)), `${f} should be excluded`).toThrow();
		}
	});

	it("copies branch-meta.json if present", () => {
		writeFileSync(join(home, "branch-meta.json"), '{"stateId":"x"}');
		mirrorPortableSubset(home, work);
		expect(readFileSync(join(work, "branch-meta.json"), "utf-8")).toBe('{"stateId":"x"}');
	});

	it("skips symlinks that resolve to a directory without throwing", () => {
		const linkedDir = mkdtempSync(join(tmpdir(), "sb-linked-dir-"));
		writeFileSync(join(linkedDir, "inside.txt"), "content\n");
		mkdirSync(join(home, "milestones"), { recursive: true });
		symlinkSync(linkedDir, join(home, "milestones", "linked-dir"));
		// Must not throw even though the symlink target is a directory.
		expect(() => mirrorPortableSubset(home, work)).not.toThrow();
		// The symlink-to-directory is skipped, so its contents are not mirrored.
		expect(() => readFileSync(join(work, "milestones", "linked-dir", "inside.txt"))).toThrow();
		rmSync(linkedDir, { recursive: true, force: true });
	});

	it("rejects symlinks that resolve outside the home dir", () => {
		const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
		writeFileSync(join(outside, "secret"), "nope");
		mkdirSync(join(home, "milestones"), { recursive: true });
		symlinkSync(join(outside, "secret"), join(home, "milestones", "leak.md"));
		mirrorPortableSubset(home, work);
		expect(() => readFileSync(join(work, "milestones", "leak.md"))).toThrow();
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("ensureStateBranch — orphan creation (no parent)", () => {
	let home: string;
	let repo: string;
	const savedTffHome = process.env.TFF_HOME;
	const savedGit: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("GIT_")) {
				savedGit[k] = process.env[k];
				Reflect.deleteProperty(process.env, k);
			}
		}
		home = mkdtempSync(join(tmpdir(), "sb-home-"));
		repo = mkdtempSync(join(tmpdir(), "sb-repo-"));
		process.env.TFF_HOME = home;
		execSync("git init -b main", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'initial'", { cwd: repo, stdio: "pipe" });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [k, v] of Object.entries(savedGit)) if (v !== undefined) process.env[k] = v;
	});

	it("creates an orphan tff-state/main with .gitattributes and branch-meta.json", async () => {
		const r = handleInit(repo);
		await ensureStateBranch(repo, r.projectId);

		const branches = execSync("git branch --list tff-state/main", { cwd: repo, encoding: "utf-8" });
		expect(branches).toContain("tff-state/main");

		const ls = execSync("git ls-tree -r --name-only tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(ls).toContain(".gitattributes");
		expect(ls).toContain("branch-meta.json");

		const attrs = execSync("git show tff-state/main:.gitattributes", {
			cwd: repo,
			encoding: "utf-8",
		});
		expect(attrs).toContain("state-snapshot.json merge=tff-snapshot");

		const meta = JSON.parse(
			execSync("git show tff-state/main:branch-meta.json", { cwd: repo, encoding: "utf-8" }),
		);
		expect(meta).toMatchObject({ parent: null, codeBranch: "main" });
		expect(typeof meta.stateId).toBe("string");
		expect(typeof meta.createdAt).toBe("string");
	});

	it("is idempotent — second call is a no-op", async () => {
		const r = handleInit(repo);
		await ensureStateBranch(repo, r.projectId);
		const firstSha = execSync("git rev-parse tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		await ensureStateBranch(repo, r.projectId);
		const secondSha = execSync("git rev-parse tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(secondSha).toBe(firstSha);
	});
});

describe("ensureStateBranch — fork from parent state branch", () => {
	let home: string;
	let repo: string;
	const savedTffHome = process.env.TFF_HOME;
	const savedGit: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("GIT_")) {
				savedGit[k] = process.env[k];
				Reflect.deleteProperty(process.env, k);
			}
		}
		home = mkdtempSync(join(tmpdir(), "sb-home-"));
		repo = mkdtempSync(join(tmpdir(), "sb-repo-"));
		process.env.TFF_HOME = home;
		execSync("git init -b main", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'initial'", { cwd: repo, stdio: "pipe" });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [k, v] of Object.entries(savedGit)) if (v !== undefined) process.env[k] = v;
	});

	it("forks tff-state/feature/foo from local tff-state/main", async () => {
		const r = handleInit(repo);
		await ensureStateBranch(repo, r.projectId); // creates tff-state/main
		const mainSha = execSync("git rev-parse tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();

		execSync("git checkout -b feature/foo", { cwd: repo, stdio: "pipe" });
		await ensureStateBranch(repo, r.projectId);

		const fooSha = execSync("git rev-parse tff-state/feature/foo", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(fooSha).toBe(mainSha);
	});

	it("3-branch heuristic: picks feature/base over main as parent for feature/foo", async () => {
		const r = handleInit(repo);

		// Ensure tff-state/main exists (on main branch)
		await ensureStateBranch(repo, r.projectId);

		// Branch feature/base off main with a new commit so its merge-base with
		// feature/foo is more recent than main's merge-base with feature/foo.
		execSync("git checkout -b feature/base", { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'feature/base commit'", { cwd: repo, stdio: "pipe" });
		await ensureStateBranch(repo, r.projectId); // creates tff-state/feature/base
		const baseSha = execSync("git rev-parse tff-state/feature/base", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();

		// Branch feature/foo off feature/base (so merge-base with feature/base is
		// more recent than the merge-base with main).
		execSync("git checkout -b feature/foo", { cwd: repo, stdio: "pipe" });
		await ensureStateBranch(repo, r.projectId);

		const fooSha = execSync("git rev-parse tff-state/feature/foo", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		// The heuristic should pick feature/base (most-recent merge-base timestamp),
		// so tff-state/feature/foo must point at the same commit as tff-state/feature/base.
		expect(fooSha).toBe(baseSha);
	});

	it("remote-fetch: recreates tff-state/main locally when only origin has it", async () => {
		// Set up a bare origin repo.
		const origin = mkdtempSync(join(tmpdir(), "sb-origin-"));
		try {
			execSync("git init --bare -b main", { cwd: origin, stdio: "pipe" });

			// Wire repo to origin and push main.
			execSync(`git remote add origin ${origin}`, { cwd: repo, stdio: "pipe" });
			execSync("git push origin main", { cwd: repo, stdio: "pipe" });

			// Create tff-state/main locally, then push it to origin.
			const r = handleInit(repo);
			await ensureStateBranch(repo, r.projectId);
			execSync("git push origin tff-state/main", { cwd: repo, stdio: "pipe" });

			// Record the SHA that origin holds.
			const originSha = execSync("git rev-parse tff-state/main", {
				cwd: repo,
				encoding: "utf-8",
			}).trim();

			// Delete the local state branch so only origin has it.
			execSync("git branch -D tff-state/main", { cwd: repo, stdio: "pipe" });

			// ensureStateBranch must fetch from origin and recreate it locally.
			await ensureStateBranch(repo, r.projectId);

			const restoredSha = execSync("git rev-parse tff-state/main", {
				cwd: repo,
				encoding: "utf-8",
			}).trim();
			expect(restoredSha).toBe(originSha);
		} finally {
			rmSync(origin, { recursive: true, force: true });
		}
	});
});

describe("ensureStateBranch — guards", () => {
	const savedTffHome = process.env.TFF_HOME;
	const savedGit: Record<string, string | undefined> = {};
	let home: string;
	let repo: string;

	beforeEach(() => {
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("GIT_")) {
				savedGit[k] = process.env[k];
				Reflect.deleteProperty(process.env, k);
			}
		}
		home = mkdtempSync(join(tmpdir(), "sb-home-"));
		repo = mkdtempSync(join(tmpdir(), "sb-repo-"));
		process.env.TFF_HOME = home;
		execSync("git init -b main", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'initial'", { cwd: repo, stdio: "pipe" });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [k, v] of Object.entries(savedGit)) if (v !== undefined) process.env[k] = v;
	});

	it("no-ops when slice-worktree sentinel is present", async () => {
		const r = handleInit(repo);
		const marker = join(home, r.projectId, "slice-worktree.marker");
		writeFileSync(marker, "true");

		await ensureStateBranch(repo, r.projectId);

		const branches = execSync("git branch --list tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		});
		expect(branches.trim()).toBe("");
	});

	it("no-ops on detached HEAD", async () => {
		const r = handleInit(repo);
		execSync("git checkout --detach", { cwd: repo, stdio: "pipe" });
		await ensureStateBranch(repo, r.projectId);
		const branches = execSync("git branch --list tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		});
		expect(branches.trim()).toBe("");
	});
});

describe("commitStateAtPhaseEnd — happy path", () => {
	const savedTffHome = process.env.TFF_HOME;
	const savedGit: Record<string, string | undefined> = {};
	let home: string;
	let repo: string;
	let projectId: string;

	beforeEach(async () => {
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("GIT_")) {
				savedGit[k] = process.env[k];
				Reflect.deleteProperty(process.env, k);
			}
		}
		home = mkdtempSync(join(tmpdir(), "sb-home-"));
		repo = mkdtempSync(join(tmpdir(), "sb-repo-"));
		process.env.TFF_HOME = home;
		execSync("git init -b main", { cwd: repo, stdio: "pipe" });
		execSync('git config user.email "t@t.com"', { cwd: repo, stdio: "pipe" });
		execSync('git config user.name "T"', { cwd: repo, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'initial'", { cwd: repo, stdio: "pipe" });
		const r = handleInit(repo);
		projectId = r.projectId;
		const db = openDatabase(join(home, projectId, "state.db"));
		applyMigrations(db, { root: repo });
		insertProject(db, { name: "p", vision: "v", id: projectId });
		db.close();
		await ensureStateBranch(repo, projectId);
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
		if (savedTffHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedTffHome;
		for (const [k, v] of Object.entries(savedGit)) if (v !== undefined) process.env[k] = v;
	});

	it("commits snapshot + artifacts to tff-state/main", async () => {
		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		const files = execSync("git ls-tree -r --name-only tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(files).toContain("state-snapshot.json");
		expect(files).toContain(".gitattributes");

		const snapJson = execSync("git show tff-state/main:state-snapshot.json", {
			cwd: repo,
			encoding: "utf-8",
		});
		const snap = JSON.parse(snapJson);
		expect(snap.project).toHaveLength(1);
		expect(snap.project[0].id).toBe(projectId);
	});

	it("commit message is '<phase>: <sliceLabel>'", async () => {
		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		const msg = execSync("git log -1 --format=%s tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(msg).toBe("plan: M01-S01");
	});

	it("no-ops when there are no changes (no empty commit)", async () => {
		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		const firstSha = execSync("git rev-parse tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		const secondSha = execSync("git rev-parse tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(secondSha).toBe(firstSha);
	});

	it("leaves no temp worktree behind", async () => {
		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		const entries = readdirSync(join(home, projectId, ".tmp")).filter((n) =>
			n.startsWith("state-wt-"),
		);
		expect(entries).toHaveLength(0);
		const worktrees = execSync("git worktree list --porcelain", {
			cwd: repo,
			encoding: "utf-8",
		});
		expect(worktrees).not.toContain("state-wt-");
	});

	it("freezeLogForSlice copies log file into tree and tags the commit message", async () => {
		mkdirSync(join(home, projectId, "logs"), { recursive: true });
		writeFileSync(join(home, projectId, "logs", "M01-S01.jsonl"), '{"phase":"plan"}\n');

		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "review",
			sliceLabel: "M01-S01",
			freezeLogForSlice: "M01-S01",
		});
		const files = execSync("git ls-tree -r --name-only tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(files).toContain("logs/M01-S01.jsonl");
		const content = execSync("git show tff-state/main:logs/M01-S01.jsonl", {
			cwd: repo,
			encoding: "utf-8",
		});
		expect(content).toBe('{"phase":"plan"}\n');
		const msg = execSync("git log -1 --format=%s tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		expect(msg).toBe("review: M01-S01 (slice complete)");
	});

	it("missing log file is warned + skipped without failing the commit", async () => {
		// no logs/ dir at all
		await commitStateAtPhaseEnd({
			repoRoot: repo,
			projectId,
			codeBranch: "main",
			phase: "review",
			sliceLabel: "M01-S01",
			freezeLogForSlice: "M01-S01",
		});
		const files = execSync("git ls-tree -r --name-only tff-state/main", {
			cwd: repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(files).not.toContain("logs/M01-S01.jsonl");
		expect(files).toContain("state-snapshot.json");
	});
});
