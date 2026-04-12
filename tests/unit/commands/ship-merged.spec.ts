import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

const mockExec = vi.fn().mockReturnValue("");
vi.mock("node:child_process", () => ({
	execFileSync: (...args: unknown[]) => mockExec(...args),
}));

vi.mock("../../../src/common/checkpoint.js", () => ({
	cleanupCheckpoints: vi.fn(),
}));

vi.mock("../../../src/common/worktree.js", () => ({
	getWorktreePath: vi.fn().mockReturnValue("/tmp/fake-worktree"),
	removeWorktree: vi.fn(),
}));

vi.mock("../../../src/common/git.js", () => ({
	branchExists: vi.fn().mockReturnValue(true),
	remoteBranchExists: vi.fn().mockReturnValue(true),
	gitEnv: vi.fn().mockReturnValue({}),
}));

import { handleShipMerged } from "../../../src/commands/ship-merged.js";

function fakePi() {
	return {
		events: { emit: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleShipMerged>[0];
}

describe("handleShipMerged", () => {
	let db: Database.Database;
	let sliceId: string;
	let milestoneId: string;

	beforeEach(() => {
		mockExec.mockReset();
		mockExec.mockReturnValue("");
		db = openDatabase(":memory:");
		applyMigrations(db);
		const projectId = insertProject(db, { name: "test", vision: "v" });
		milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});
		sliceId = insertSlice(db, {
			milestoneId,
			number: 1,
			title: "slice",
		});
		updateSliceStatus(db, sliceId, "shipping");
	});

	afterEach(() => {
		db.close();
	});

	it("closes the slice and emits phase_complete", () => {
		const pi = fakePi();
		const result = handleShipMerged(pi, db, "/tmp", sliceId);
		expect(result.success).toBe(true);
		const slice = must(getSlice(db, sliceId));
		expect(slice.status).toBe("closed");
	});

	it("refuses to close an already-closed slice", () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = handleShipMerged(fakePi(), db, "/tmp", sliceId);
		expect(result.success).toBe(false);
		expect(result.message).toContain("already closed");
	});

	it("returns a not-found error for unknown slice", () => {
		const result = handleShipMerged(fakePi(), db, "/tmp", "nope");
		expect(result.success).toBe(false);
		expect(result.message).toContain("not found");
	});
});
