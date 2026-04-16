import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMilestone } from "../../../src/commands/new-milestone.js";
import { applyMigrations, insertProject, openDatabase } from "../../../src/common/db.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";

describe("M11-S4: parallel milestone creation in two clones", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
	});
	afterEach(() => fx.cleanup());

	it("Alice and Bob both create M01 → distinct UUID branches → push without collision", () => {
		// Both clones share the same project (Bob cloned from Alice's origin and
		// inherited the .tff-project-id file). They share one state.db via TFF_HOME.
		expect(fx.aliceProjectId).toBe(fx.bobProjectId);
		const projectId = fx.aliceProjectId;

		// Alice creates a milestone in her clone
		const aDb = openDatabase(join(fx.home, projectId, "state.db"));
		applyMigrations(aDb, { root: fx.alice });
		insertProject(aDb, { name: "shared", vision: "v", id: projectId });
		const aResult = createMilestone(aDb, fx.alice, projectId, "Alice's milestone");
		aDb.close();

		// Bob creates a milestone in his clone (same project, same DB)
		const bDb = openDatabase(join(fx.home, projectId, "state.db"));
		applyMigrations(bDb, { root: fx.bob });
		const bResult = createMilestone(bDb, fx.bob, projectId, "Bob's milestone");
		bDb.close();

		// Both milestones got UUID-form branches (milestone/<8hex>)
		expect(aResult.branch).toMatch(/^milestone\/[0-9a-f]{8}$/);
		expect(bResult.branch).toMatch(/^milestone\/[0-9a-f]{8}$/);
		// The UUIDs are distinct (~1-in-4B collision; should never fire in practice)
		expect(aResult.branch).not.toBe(bResult.branch);

		// Both branches were pushed to the shared origin with no collision
		const remoteBranches = execFileSync("git", ["-C", fx.alice, "ls-remote", "--heads", "origin"], {
			encoding: "utf-8",
		});
		expect(remoteBranches).toContain(aResult.branch);
		expect(remoteBranches).toContain(bResult.branch);
	});
});
