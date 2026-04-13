import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSlicePrUrl,
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

const mockView = vi.fn();
vi.mock("../../../src/common/gh-client.js", () => ({
	getPrTools: () => ({ view: mockView }),
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
		mockView.mockReset();
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

	it("closes the slice and emits phase_complete", async () => {
		const pi = fakePi();
		const result = await handleShipMerged(pi, db, "/tmp", sliceId);
		expect(result.success).toBe(true);
		// Reconciler rule 1: ship/completed + pr_url non-null → closed.
		// Verify phase_complete was emitted; reconciler handles the DB write.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"tff:phase",
			expect.objectContaining({ type: "phase_complete", phase: "ship" }),
		);
	});

	it("refuses to close an already-closed slice", async () => {
		updateSliceStatus(db, sliceId, "closed");
		const result = await handleShipMerged(fakePi(), db, "/tmp", sliceId);
		expect(result.success).toBe(false);
		expect(result.message).toContain("already closed");
	});

	it("returns a not-found error for unknown slice", async () => {
		const result = await handleShipMerged(fakePi(), db, "/tmp", "nope");
		expect(result.success).toBe(false);
		expect(result.message).toContain("not found");
	});

	it("emits no squash warning when PR merge commit has a single parent", async () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		mockView.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ mergeCommit: { oid: "abc123" } }),
			stderr: "",
		});
		// git rev-list --parents -n 1 abc123 → "abc123 parent1" (1 parent = squash).
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			if (cmdArgs?.[0] === "rev-list") return "abc123 parent1\n";
			return "";
		});
		const pi = fakePi();
		const slice = must(getSlice(db, sliceId));
		const result = await handleShipMerged(pi, db, "/tmp", slice.id);
		expect(result.success).toBe(true);
		const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
		for (const call of calls) {
			expect(String(call[0])).not.toContain("WARNING");
		}
	});

	it("warns when PR merge commit has multiple parents (merge commit)", async () => {
		updateSlicePrUrl(db, sliceId, "https://github.com/org/repo/pull/42");
		mockView.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ mergeCommit: { oid: "abc123" } }),
			stderr: "",
		});
		mockExec.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			if (cmdArgs?.[0] === "rev-list") return "abc123 p1 p2\n";
			return "";
		});
		const pi = fakePi();
		const slice = must(getSlice(db, sliceId));
		const result = await handleShipMerged(pi, db, "/tmp", slice.id);
		expect(result.success).toBe(true);
		const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
		const warned = calls.some((c) => String(c[0]).includes("WARNING"));
		expect(warned).toBe(true);
	});
});
