import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertProject, openDatabase } from "../../../src/common/db.js";
import {
	commitStateAtPhaseEnd,
	ensureStateBranch,
	pushWithRebaseRetry,
} from "../../../src/common/state-branch.js";
import { finalizeStateBranchForMilestone } from "../../../src/common/state-ship.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

async function seedMilestoneStateBranch(fx: TwoClone, milestoneBranch: string): Promise<void> {
	await ensureStateBranch(fx.alice, fx.aliceProjectId);
	const db = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
	insertProject(db, { name: "p", vision: "v", id: fx.aliceProjectId });
	db.close();
	await commitStateAtPhaseEnd({
		repoRoot: fx.alice,
		projectId: fx.aliceProjectId,
		codeBranch: "main",
		phase: "plan",
		sliceLabel: "M01-S01",
	});
	execFileSync("git", ["checkout", "tff-state/main"], { cwd: fx.alice, stdio: "pipe" });
	await pushWithRebaseRetry(fx.alice, "tff-state/main");
	execFileSync("git", ["checkout", "main"], { cwd: fx.alice, stdio: "pipe" });

	execFileSync("git", ["checkout", "-b", milestoneBranch], { cwd: fx.alice, stdio: "pipe" });
	execFileSync("git", ["commit", "--allow-empty", "-m", "milestone init"], {
		cwd: fx.alice,
		stdio: "pipe",
	});
	await ensureStateBranch(fx.alice, fx.aliceProjectId);

	const db2 = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
	db2
		.prepare(
			"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run("M99", fx.aliceProjectId, 99, "test", "completing", milestoneBranch);
	db2.close();
	await commitStateAtPhaseEnd({
		repoRoot: fx.alice,
		projectId: fx.aliceProjectId,
		codeBranch: milestoneBranch,
		phase: "plan",
		sliceLabel: "M99-S01",
	});
	execFileSync("git", ["checkout", `tff-state/${milestoneBranch}`], {
		cwd: fx.alice,
		stdio: "pipe",
	});
	await pushWithRebaseRetry(fx.alice, `tff-state/${milestoneBranch}`);
	execFileSync("git", ["checkout", milestoneBranch], { cwd: fx.alice, stdio: "pipe" });
}

describe("finalizeStateBranchForMilestone", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});
	afterEach(() => fx.cleanup());

	it("returns 'skipped-no-state-branch' when no tff-state/<milestoneBranch> exists", async () => {
		// milestone branch exists as a code branch but no state branch for it
		execFileSync("git", ["checkout", "-b", "milestone/M99"], { cwd: fx.alice, stdio: "pipe" });
		execFileSync("git", ["commit", "--allow-empty", "-m", "milestone init"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		execFileSync("git", ["checkout", "main"], { cwd: fx.alice, stdio: "pipe" });

		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch: "milestone/M99",
			parentBranch: "main",
		});

		expect(outcome).toBe("skipped-no-state-branch");
	});

	it("'finalized' happy path: merges into parent, tags, deletes local+remote", async () => {
		const milestoneBranch = "milestone/M99";
		await seedMilestoneStateBranch(fx, milestoneBranch);

		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch,
			parentBranch: "main",
		});

		expect(outcome).toBe("finalized");

		const local = execFileSync("git", ["branch", "--list", "tff-state/milestone/M99"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(local).toBe("");

		const remote = execFileSync(
			"git",
			["ls-remote", "--heads", "origin", "tff-state/milestone/M99"],
			{
				cwd: fx.alice,
				encoding: "utf-8",
			},
		).trim();
		expect(remote).toBe("");

		const tags = execFileSync("git", ["ls-remote", "--tags", "origin"], {
			cwd: fx.alice,
			encoding: "utf-8",
		});
		expect(tags).toMatch(/refs\/tags\/tff-state\/_archived\/milestone\/M99-/);

		execFileSync("git", ["fetch", "origin", "tff-state/main:tff-state/main"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		const log = execFileSync("git", ["log", "tff-state/main", "--pretty=%P", "-n", "1"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(log.split(" ").length).toBeGreaterThanOrEqual(2);
	});

	it("'finalized-local-only' when no origin remote", async () => {
		const milestoneBranch = "milestone/M88";
		await seedMilestoneStateBranch(fx, milestoneBranch);
		// Remove the origin remote to simulate no-origin
		execFileSync("git", ["remote", "remove", "origin"], { cwd: fx.alice, stdio: "pipe" });

		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch,
			parentBranch: "main",
		});

		expect(outcome).toBe("finalized-local-only");

		// Local deletion happened
		const local = execFileSync("git", ["branch", "--list", "tff-state/milestone/M88"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(local).toBe("");

		// Tag exists locally
		const tags = execFileSync("git", ["tag", "--list", "tff-state/_archived/milestone/M88-*"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(tags).not.toBe("");
	});

	it("is idempotent: second call returns skipped-no-state-branch", async () => {
		const milestoneBranch = "milestone/M77";
		await seedMilestoneStateBranch(fx, milestoneBranch);

		const first = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch,
			parentBranch: "main",
		});
		expect(first).toBe("finalized");

		const second = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch,
			parentBranch: "main",
		});
		expect(second).toBe("skipped-no-state-branch");
	});

	it("lazy-creates empty orphan parent when tff-state/<parent> is missing", async () => {
		execFileSync("git", ["checkout", "-b", "milestone/M66"], { cwd: fx.alice, stdio: "pipe" });
		execFileSync("git", ["commit", "--allow-empty", "-m", "milestone init"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		// Remove tff-state/main locally (auto-created by ensureStateBranch for first project init)
		try {
			execFileSync("git", ["branch", "-D", "tff-state/main"], {
				cwd: fx.alice,
				stdio: "pipe",
			});
		} catch {
			// tff-state/main may not exist yet — fine
		}
		// Also remove from origin if pushed
		try {
			execFileSync("git", ["push", "origin", ":tff-state/main"], {
				cwd: fx.alice,
				stdio: "pipe",
			});
		} catch {
			// non-fatal
		}

		const db = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		insertProject(db, { name: "p", vision: "v", id: fx.aliceProjectId });
		db.close();
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "milestone/M66",
			phase: "plan",
			sliceLabel: "M66-S01",
		});

		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch: "milestone/M66",
			parentBranch: "main",
		});
		expect(outcome).toBe("finalized");

		// tff-state/main now exists on origin with the milestone merged in
		const remote = execFileSync("git", ["ls-remote", "--heads", "origin", "tff-state/main"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(remote).not.toBe("");
	});

	it("'conflict-backup' when parent has an unresolvable snapshot conflict", async () => {
		const milestoneBranch = "milestone/M55";
		await seedMilestoneStateBranch(fx, milestoneBranch);

		// Force a hard conflict by editing tff-state/main's snapshot directly via a
		// disposable worktree. We bypass commitStateAtPhaseEnd + the shared DB —
		// otherwise the DB mutation would leak into the milestone-side terminal
		// commit that finalize performs in Step 3 and the snapshots would agree.
		//
		// Base (fork point on tff-state/main) has no M99 row. The milestone side
		// already wrote M99 with name="test" in seedMilestoneStateBranch. Here we
		// give main its own M99 row with a different name → per-field 3-way merge
		// sees base=undefined, ours="main-side-name", theirs="test" → conflict.
		const wtDir = mkdtempSync(join(tmpdir(), "state-conflict-wt-"));
		try {
			execFileSync("git", ["worktree", "add", wtDir, "tff-state/main"], {
				cwd: fx.alice,
				stdio: "pipe",
			});
			const snapPath = join(wtDir, "state-snapshot.json");
			const snap = JSON.parse(readFileSync(snapPath, "utf-8")) as {
				milestone: Array<Record<string, unknown>>;
				[k: string]: unknown;
			};
			snap.milestone.push({
				id: "M99",
				project_id: fx.aliceProjectId,
				number: 99,
				name: "main-side-name",
				status: "in_progress",
				branch: "main",
				created_at: new Date().toISOString(),
			});
			writeFileSync(snapPath, `${JSON.stringify(snap, null, 2)}\n`, "utf-8");
			execFileSync("git", ["add", "state-snapshot.json"], { cwd: wtDir, stdio: "pipe" });
			execFileSync("git", ["commit", "-m", "test: diverge M99 on main"], {
				cwd: wtDir,
				stdio: "pipe",
			});
			execFileSync("git", ["push", "origin", "tff-state/main"], {
				cwd: wtDir,
				stdio: "pipe",
			});
		} finally {
			try {
				execFileSync("git", ["worktree", "remove", "--force", wtDir], {
					cwd: fx.alice,
					stdio: "pipe",
				});
			} catch {
				// best-effort
			}
			rmSync(wtDir, { recursive: true, force: true });
		}
		// Sync the local tff-state/main to the new remote tip so finalize sees it.
		execFileSync("git", ["fetch", "origin", "tff-state/main:tff-state/main"], {
			cwd: fx.alice,
			stdio: "pipe",
		});

		const outcome = await finalizeStateBranchForMilestone({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			milestoneBranch,
			parentBranch: "main",
		});

		expect(outcome).toBe("conflict-backup");

		// Live state branch preserved locally (not deleted on conflict).
		const local = execFileSync("git", ["branch", "--list", "tff-state/milestone/M55"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(local).not.toBe("");

		// Backup ref exists on origin.
		const backups = execFileSync("git", ["ls-remote", "--heads", "origin"], {
			cwd: fx.alice,
			encoding: "utf-8",
		});
		expect(backups).toMatch(/tff-state\/milestone\/M55--ship-conflict-/);
	});
});
