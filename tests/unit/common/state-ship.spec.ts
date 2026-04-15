import { execFileSync } from "node:child_process";
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
});
