import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import type { PhaseContext, PhaseModule } from "../../../src/common/phase.js";
import { runPhaseWithFreshContext } from "../../../src/common/phase.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

describe("M10-S03: commitStateAtPhaseEnd wired into runPhaseWithFreshContext", () => {
	let fx: TwoClone;

	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);
		seedEnabledSettings(fx.bob);
	});

	afterEach(() => fx.cleanup());

	it("commits a new SHA on tff-state/main after a successful prepare()", async () => {
		// Seed the state branch so commitStateAtPhaseEnd has somewhere to write.
		await ensureStateBranch(fx.alice, fx.aliceProjectId);

		const shaBefore = execSync("git rev-parse tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();

		// Seed the database with a project, milestone, and slice so
		// getSlice() returns a real row.
		const dbPath = join(fx.home, fx.aliceProjectId, "state.db");
		const db = openDatabase(dbPath);
		applyMigrations(db, { root: fx.alice });
		insertProject(db, { name: "p", vision: "v", id: fx.aliceProjectId });
		const milestoneId = insertMilestone(db, {
			projectId: fx.aliceProjectId,
			number: 1,
			name: "M01",
			branch: "main",
		});
		const sliceId = insertSlice(db, { milestoneId, number: 1, title: "S01" });

		const phaseCtx = {
			root: fx.alice,
			db,
			milestoneNumber: 1,
			slice: { id: sliceId, number: 1, status: "planning" },
			settings: {},
			pi: { sendMessage: vi.fn(), events: { emit() {} } },
			fffBridge: null,
		} as unknown as PhaseContext;

		const phaseModule: PhaseModule = {
			prepare: vi.fn().mockResolvedValue({
				success: true,
				retry: false,
				message: "run phase",
			}),
		};

		const cmdCtx = {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as Parameters<typeof runPhaseWithFreshContext>[0]["cmdCtx"];

		const result = await runPhaseWithFreshContext({
			phaseModule,
			phaseCtx,
			cmdCtx,
			phase: "plan",
		});

		db.close();

		expect(result.success).toBe(true);

		const shaAfter = execSync("git rev-parse tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();

		expect(shaAfter).not.toBe(shaBefore);

		const msg = execSync("git log -1 --format=%s tff-state/main", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(msg).toBe("plan: M01-S01");
	});
});
