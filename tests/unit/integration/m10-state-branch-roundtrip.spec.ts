import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, insertProject, openDatabase } from "../../../src/common/db.js";
import {
	commitStateAtPhaseEnd,
	ensureStateBranch,
	pushWithRebaseRetry,
} from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";

describe("M10-S03: state-branch roundtrip", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
	});
	afterEach(() => fx.cleanup());

	it("alice commits, bob fetches and reads the same snapshot", async () => {
		// Alice: insert a project, commit & push state branch
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		const aliceDbPath = join(fx.home, fx.aliceProjectId, "state.db");
		const aliceDb = openDatabase(aliceDbPath);
		applyMigrations(aliceDb, { root: fx.alice });
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
		expect(await pushWithRebaseRetry(fx.alice, "tff-state/main")).toBe("pushed");
		execSync("git checkout main", { cwd: fx.alice, stdio: "pipe" });

		// Bob: fetch state branch, read snapshot file directly
		execSync("git fetch origin tff-state/main:tff-state/main", { cwd: fx.bob, stdio: "pipe" });
		const attrs = execSync("git show tff-state/main:.gitattributes", {
			cwd: fx.bob,
			encoding: "utf-8",
		});
		expect(attrs).toContain("state-snapshot.json merge=tff-snapshot");
		const snapStr = execSync("git show tff-state/main:state-snapshot.json", {
			cwd: fx.bob,
			encoding: "utf-8",
		});
		const snap = JSON.parse(snapStr);
		expect(snap.project).toHaveLength(1);
		expect(snap.project[0].id).toBe(fx.aliceProjectId);
	});
});
