import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertProject, openDatabase } from "../../../src/common/db.js";
import {
	commitStateAtPhaseEnd,
	ensureStateBranch,
	pushWithRebaseRetry,
} from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("M10-S03: multi-machine rebase", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});
	afterEach(() => fx.cleanup());

	it("bob's non-ff push fetches+rebases through merge driver then re-pushes", async () => {
		// Alice initialises + pushes tff-state/main
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		const aliceDb = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		insertProject(aliceDb, { name: "p", vision: "v", id: fx.aliceProjectId });
		aliceDb.close();
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M01-S01",
		});
		execSync("git checkout tff-state/main", { cwd: fx.alice, stdio: "pipe" });
		await pushWithRebaseRetry(fx.alice, "tff-state/main");
		execSync("git checkout main", { cwd: fx.alice, stdio: "pipe" });

		// Bob fetches + commits his own (disjoint) state change
		execSync("git fetch origin tff-state/main:tff-state/main", { cwd: fx.bob, stdio: "pipe" });
		const bobDb = openDatabase(join(fx.home, fx.bobProjectId, "state.db"));
		// Note: both ran handleInit which inserts the same project id since
		// .tff-project-id is shared. Use a disjoint milestone insertion.
		// Milestone table columns: id, project_id, number, name, status, branch
		bobDb
			.prepare(
				"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("M02", fx.aliceProjectId, 2, "Bob's milestone", "created", "main");
		bobDb.close();
		await commitStateAtPhaseEnd({
			repoRoot: fx.bob,
			projectId: fx.bobProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M02-S01",
		});
		execSync("git checkout tff-state/main", { cwd: fx.bob, stdio: "pipe" });

		// Meanwhile alice makes a concurrent commit and pushes first
		const aliceDb2 = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		aliceDb2
			.prepare(
				"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("M03", fx.aliceProjectId, 3, "Alice's milestone", "created", "main");
		aliceDb2.close();
		await commitStateAtPhaseEnd({
			repoRoot: fx.alice,
			projectId: fx.aliceProjectId,
			codeBranch: "main",
			phase: "plan",
			sliceLabel: "M03-S01",
		});
		execSync("git checkout tff-state/main", { cwd: fx.alice, stdio: "pipe" });
		await pushWithRebaseRetry(fx.alice, "tff-state/main");
		execSync("git checkout main", { cwd: fx.alice, stdio: "pipe" });

		// Bob pushes — must rebase alice's M03 onto his M02 via the merge driver
		const outcome = await pushWithRebaseRetry(fx.bob, "tff-state/main");
		expect(outcome).toBe("pushed");
		// Final snapshot contains both milestones
		const snapStr = execSync("git show tff-state/main:state-snapshot.json", {
			cwd: fx.bob,
			encoding: "utf-8",
		});
		expect(snapStr).not.toContain("<<<<<<<");
		expect(snapStr).not.toContain("=======");
		expect(snapStr).not.toContain(">>>>>>>");
		const finalSnap = JSON.parse(snapStr);
		const ids = finalSnap.milestone.map((m: { id: string }) => m.id);
		expect(ids).toContain("M02");
		expect(ids).toContain("M03");
	});
});
