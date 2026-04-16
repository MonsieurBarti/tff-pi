import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCompleteMilestoneMerged } from "../../../src/commands/complete-milestone-merged.js";
import { getMilestone, insertProject, openDatabase } from "../../../src/common/db.js";
import {
	commitStateAtPhaseEnd,
	ensureStateBranch,
	pushWithRebaseRetry,
} from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("M10-S04: ship tombstone (single clone end-to-end)", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});
	afterEach(() => fx.cleanup());

	const fakePi = {
		events: { emit: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleCompleteMilestoneMerged>[0];

	it("runs the full finalize flow: parent merge + tombstone + delete", async () => {
		// Seed: project row + parent state branch, then milestone code branch + its state branch.
		// Mirrors tests/unit/common/state-ship.spec.ts seedMilestoneStateBranch pattern:
		// insert the milestone row AFTER the parent-state commit so the milestone-side
		// snapshot diverges from tff-state/main. Otherwise merge is a no-op.
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		const db = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		insertProject(db, { name: "p", vision: "v", id: fx.aliceProjectId });
		db.close();
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M10-S01",
		});
		execFileSync("git", ["checkout", "tff-state/main"], { cwd: fx.alice, stdio: "pipe" });
		await pushWithRebaseRetry(fx.alice, "tff-state/main");
		execFileSync("git", ["checkout", "main"], { cwd: fx.alice, stdio: "pipe" });

		execFileSync("git", ["checkout", "-b", "milestone/M10"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		execFileSync("git", ["commit", "--allow-empty", "-m", "m init"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		await ensureStateBranch(fx.alice, fx.aliceProjectId);

		const db2 = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		db2
			.prepare(
				"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("M10", fx.aliceProjectId, 10, "Test", "completing", "milestone/M10");
		db2.close();
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "milestone/M10",
			phase: "plan",
			sliceLabel: "M10-S02",
		});
		execFileSync("git", ["checkout", "tff-state/milestone/M10"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		await pushWithRebaseRetry(fx.alice, "tff-state/milestone/M10");
		execFileSync("git", ["checkout", "milestone/M10"], { cwd: fx.alice, stdio: "pipe" });

		// Run the handler
		const dbRun = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		const result = await handleCompleteMilestoneMerged(fakePi, dbRun, fx.alice, "M10");
		expect(result.success).toBe(true);
		expect(getMilestone(dbRun, "M10")?.status).toBe("closed");
		dbRun.close();

		// Assert: live state branch gone locally and on origin
		expect(
			execFileSync("git", ["branch", "--list", "tff-state/milestone/M10"], {
				cwd: fx.alice,
				encoding: "utf-8",
			}).trim(),
		).toBe("");
		expect(
			execFileSync("git", ["ls-remote", "--heads", "origin", "tff-state/milestone/M10"], {
				cwd: fx.alice,
				encoding: "utf-8",
			}).trim(),
		).toBe("");

		// Assert: archive tag on origin
		expect(
			execFileSync("git", ["ls-remote", "--tags", "origin"], {
				cwd: fx.alice,
				encoding: "utf-8",
			}),
		).toMatch(/refs\/tags\/tff-state\/_archived\/milestone\/M10-/);

		// Assert: parent state branch has a merge commit (>=2 parents)
		execFileSync("git", ["fetch", "origin", "tff-state/main:tff-state/main"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		const parents = execFileSync("git", ["log", "tff-state/main", "--pretty=%P", "-n", "1"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(parents.split(" ").length).toBeGreaterThanOrEqual(2);

		// Idempotency: second run is already closed
		const dbAgain = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		const r2 = await handleCompleteMilestoneMerged(fakePi, dbAgain, fx.alice, "M10");
		expect(r2.success).toBe(false);
		expect(r2.message).toMatch(/already closed/i);
		dbAgain.close();
	});
});
