import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCompleteMilestoneChanges } from "../../../src/commands/complete-milestone-changes.js";
import { getMilestone, insertProject, openDatabase } from "../../../src/common/db.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";

describe("M10-S04: milestone-needs-changes integration", () => {
	let fx: TwoClone;
	beforeEach(async () => {
		fx = await makeTwoClone();
	});
	afterEach(() => fx.cleanup());

	const fakePi = {
		events: { emit: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleCompleteMilestoneChanges>[0];

	it("writes MILESTONE_REVIEW_FEEDBACK.md and does not touch state branches", async () => {
		const db = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		insertProject(db, { name: "p", vision: "v", id: fx.aliceProjectId });
		const p = db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
		db.prepare(
			"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
		).run("M10", p.id, 10, "Test", "completing", "milestone/M10");
		db.close();

		// Pre-snapshot of state branches
		const before = execFileSync("git", ["branch", "--list", "tff-state/*"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();

		const db2 = openDatabase(join(fx.home, fx.aliceProjectId, "state.db"));
		const result = await handleCompleteMilestoneChanges(
			fakePi,
			db2,
			fx.alice,
			"M10",
			"Please adjust the PR description.",
		);
		expect(result.success).toBe(true);
		expect(getMilestone(db2, "M10")?.status).toBe("completing");
		db2.close();

		const feedbackPath = join(
			fx.alice,
			".tff",
			"milestones",
			"M10",
			"MILESTONE_REVIEW_FEEDBACK.md",
		);
		expect(existsSync(feedbackPath)).toBe(true);
		expect(readFileSync(feedbackPath, "utf-8")).toContain("Please adjust the PR description.");

		// State branches unchanged
		const after = execFileSync("git", ["branch", "--list", "tff-state/*"], {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();
		expect(after).toBe(before);
	});
});
