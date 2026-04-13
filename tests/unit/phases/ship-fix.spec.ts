import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTffDirectory, writeArtifact } from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { shipFixPhase } from "../../../src/phases/ship-fix.js";
import { must } from "../../helpers.js";

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as PhaseContext["pi"];
}

describe("shipFixPhase", () => {
	let db: Database.Database;
	let root: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-ship-fix-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "v" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth fix" });
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	function makeCtx(): PhaseContext {
		const projectId = must(getProject(db)).id;
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		const slice = must(getSlices(db, milestoneId)[0]);
		updateSliceStatus(db, slice.id, "shipping");
		return {
			pi: makePi(),
			db,
			root,
			slice,
			milestoneNumber: 1,
			settings: DEFAULT_SETTINGS,
		};
	}

	it("returns an error when REVIEW_FEEDBACK.md is missing", async () => {
		const ctx = makeCtx();
		const result = await shipFixPhase.prepare(ctx);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/REVIEW_FEEDBACK/);
	});

	it("produces a prompt referencing the worktree and feedback when present", async () => {
		const ctx = makeCtx();
		writeArtifact(
			root,
			"milestones/M01/slices/M01-S01/REVIEW_FEEDBACK.md",
			"# Review Feedback\n\nplease rename foo",
		);
		const result = await shipFixPhase.prepare(ctx);
		expect(result.success).toBe(true);
		expect(result.message).toContain("M01-S01");
		expect(result.message).toContain("Auth fix");
		expect(result.message).toContain("please rename foo");
		expect(result.message).toContain("worktrees/M01-S01");
		expect(result.message).toContain("bun run lint:fix");
	});

	it("emits phase_start event on prepare", async () => {
		const ctx = makeCtx();
		writeArtifact(
			root,
			"milestones/M01/slices/M01-S01/REVIEW_FEEDBACK.md",
			"# Review Feedback\n\nfix",
		);
		await shipFixPhase.prepare(ctx);
		const emit = ctx.pi.events.emit as ReturnType<typeof vi.fn>;
		const startCall = emit.mock.calls.find(
			(c) => (c[1] as { type?: string })?.type === "phase_start",
		);
		expect(startCall).toBeTruthy();
	});
});
