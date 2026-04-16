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

describe("M10-S04: clone-and-resume two-clone", () => {
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

	it("bob finalizes milestone; alice fetches and sees the archive", async () => {
		// Alice: seed parent state branch + push
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		const aDb = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		insertProject(aDb, { name: "p", vision: "v", id: fx.aliceProjectId });
		aDb.close();
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

		// Alice: create milestone code branch, push it, insert milestone row, commit state
		execFileSync("git", ["checkout", "-b", "milestone/M10"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		execFileSync("git", ["commit", "--allow-empty", "-m", "m init"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		execFileSync("git", ["push", "-u", "origin", "milestone/M10"], {
			cwd: fx.alice,
			stdio: "pipe",
		});
		await ensureStateBranch(fx.alice, fx.aliceProjectId);

		// Insert milestone row AFTER parent-state-branch commit so milestone snapshot diverges.
		const aDb2 = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		const ap = aDb2.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
		aDb2
			.prepare(
				"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("M10", ap.id, 10, "Test", "completing", "milestone/M10");
		aDb2.close();
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

		// Bob: fetch milestone code branch + state branch
		execFileSync("git", ["fetch", "origin", "milestone/M10:milestone/M10"], {
			cwd: fx.bob,
			stdio: "pipe",
		});
		execFileSync("git", ["checkout", "milestone/M10"], { cwd: fx.bob, stdio: "pipe" });
		await ensureStateBranch(fx.bob, fx.bobProjectId);

		// Bob's DB: the harness shares state.db across clones (same projectId, same home).
		// Verify Bob can see the M10 row.
		const bDb = openDatabase(join(fx.home, fx.bobProjectId, "state.db"));
		const bMilestone = getMilestone(bDb, "M10");
		expect(bMilestone).not.toBeNull();
		expect(bMilestone?.status).toBe("completing");
		bDb.close();

		// Bob runs the finalize command
		const bDb2 = openDatabase(join(fx.home, fx.bobProjectId, "state.db"));
		const result = await handleCompleteMilestoneMerged(fakePi, bDb2, fx.bob, "M10");
		expect(result.success).toBe(true);
		expect(getMilestone(bDb2, "M10")?.status).toBe("closed");
		bDb2.close();

		// Alice fetches and confirms the state branch is gone + tag exists
		execFileSync("git", ["fetch", "--prune", "origin"], { cwd: fx.alice, stdio: "pipe" });
		expect(
			execFileSync("git", ["ls-remote", "--heads", "origin", "tff-state/milestone/M10"], {
				cwd: fx.alice,
				encoding: "utf-8",
			}).trim(),
		).toBe("");
		expect(
			execFileSync("git", ["ls-remote", "--tags", "origin"], {
				cwd: fx.alice,
				encoding: "utf-8",
			}),
		).toMatch(/refs\/tags\/tff-state\/_archived\/milestone\/M10-/);
	});
});
