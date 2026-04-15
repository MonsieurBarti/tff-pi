import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("M10-S03: lazy fork tff-state/<branch> from tff-state/main", () => {
	let fx: TwoClone;

	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});

	afterEach(() => fx.cleanup());

	it("forks tff-state/feature/foo from tff-state/main as a descendant", async () => {
		// Step 1: create tff-state/main
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		const mainSha = execSync("git rev-parse tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();

		// Step 2: switch to a feature branch
		execSync("git checkout -b feature/foo", { cwd: fx.alice, stdio: "pipe" });

		// Step 3: create tff-state/feature/foo (lazy fork from tff-state/main)
		await ensureStateBranch(fx.alice, fx.aliceProjectId);

		const fooSha = execSync("git rev-parse tff-state/feature/foo", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();

		// The fork should point at the same commit — no new state commits yet
		expect(fooSha).toBe(mainSha);

		// Ancestry check: tff-state/main is an ancestor of tff-state/feature/foo
		// (trivially true when they share the same SHA — exit 0 means is-ancestor)
		expect(() =>
			execSync("git merge-base --is-ancestor tff-state/main tff-state/feature/foo", {
				cwd: fx.alice,
				stdio: "pipe",
			}),
		).not.toThrow();
	});
});
