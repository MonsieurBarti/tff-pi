import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleCompleteMilestoneMerged } from "../../../src/commands/complete-milestone-merged.js";
import {
	applyMigrations,
	getMilestone,
	insertMilestone,
	insertProject,
	updateMilestoneStatus,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { must } from "../../helpers.js";

// Mutable outcome so each test can override
let mockOutcome = "skipped-no-state-branch";

vi.mock("../../../src/common/state-ship.js", () => ({
	finalizeStateBranchForMilestone: vi.fn().mockImplementation(() => Promise.resolve(mockOutcome)),
}));

vi.mock("../../../src/common/project-home.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/project-home.js")>();
	return {
		...actual,
		readProjectIdFile: vi.fn().mockReturnValue("proj-123"),
	};
});

vi.mock("../../../src/common/git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/git.js")>();
	return {
		...actual,
		getDefaultBranch: vi.fn().mockReturnValue("main"),
	};
});

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleCompleteMilestoneMerged>[0];
}

describe("handleCompleteMilestoneMerged — event log (complete-milestone-merged)", () => {
	let db: Database.Database;
	let root: string;
	let milestoneId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-cmm-el-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		milestoneId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/m01",
		});
		updateMilestoneStatus(db, milestoneId, "completing");
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("appends complete-milestone-merged event, sets status closed, advances cursor (skipped-no-state-branch)", async () => {
		mockOutcome = "skipped-no-state-branch";
		const result = await handleCompleteMilestoneMerged(makePi(), db, root, milestoneId);

		expect(result.success).toBe(true);

		const stored = must(getMilestone(db, milestoneId));
		expect(stored.status).toBe("closed");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("complete-milestone-merged");
		expect(events[0]?.params).toMatchObject({ milestoneId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});

	test("appends event and closes milestone for finalized outcome", async () => {
		mockOutcome = "finalized";
		const result = await handleCompleteMilestoneMerged(makePi(), db, root, milestoneId);

		expect(result.success).toBe(true);
		expect(must(getMilestone(db, milestoneId)).status).toBe("closed");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("complete-milestone-merged");
	});

	test("appends event and closes milestone for skipped-disabled outcome", async () => {
		mockOutcome = "skipped-disabled";
		const result = await handleCompleteMilestoneMerged(makePi(), db, root, milestoneId);

		expect(result.success).toBe(true);
		expect(must(getMilestone(db, milestoneId)).status).toBe("closed");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("complete-milestone-merged");
	});

	test("does NOT append event on conflict-backup outcome; milestone stays completing", async () => {
		mockOutcome = "conflict-backup";
		const result = await handleCompleteMilestoneMerged(makePi(), db, root, milestoneId);

		expect(result.success).toBe(false);

		const stored = must(getMilestone(db, milestoneId));
		expect(stored.status).toBe("completing");

		const events = readEvents(root);
		expect(events).toHaveLength(0);
	});
});
