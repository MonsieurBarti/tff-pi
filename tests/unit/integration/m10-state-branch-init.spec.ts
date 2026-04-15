import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";

describe("M10-S03: state-branch init (orphan creation)", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
	});
	afterEach(() => fx.cleanup());

	it("creates tff-state/main as orphan with .gitattributes and branch-meta.json", async () => {
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		const files = execSync("git ls-tree -r --name-only tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(files).toContain(".gitattributes");
		expect(files).toContain("branch-meta.json");
		const attrs = execSync("git show tff-state/main:.gitattributes", {
			cwd: fx.alice,
			encoding: "utf-8",
		});
		expect(attrs).toContain("state-snapshot.json merge=tff-snapshot");
	});
});
