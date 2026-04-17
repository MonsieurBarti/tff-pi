import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getSlice,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
	updatePhaseRun,
} from "../../../src/common/db.js";
import { reconcileSliceStatus } from "../../../src/common/derived-state.js";

// ---------------------------------------------------------------------------
// These tests verify reconcileSliceStatus directly. The old
// EventLogger → reconciler integration is superseded: EventLogger is deleted
// and reconciliation is now called directly from projection handlers and
// transition.ts. Tests here confirm the reconciler produces correct slice
// statuses from phase_run + artifact state.
// ---------------------------------------------------------------------------

describe("reconcileSliceStatus", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "reconciler-integ-"));
		db = openDatabase(":memory:");
		applyMigrations(db);
		const projectId = insertProject(db, { name: "p", vision: "v" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "m",
			branch: "m01",
		});
		sliceId = insertSlice(db, { milestoneId, number: 1, title: "s" });
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("transitions slice to 'planning' when plan phase_run is started", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		reconcileSliceStatus(db, root, sliceId);
		expect(getSlice(db, sliceId)?.status).toBe("planning");
	});

	it("transitions slice back to 'executing' when verify phase_run fails", () => {
		// Start verify, fail it
		const verifyId = insertPhaseRun(db, {
			sliceId,
			phase: "verify",
			status: "started",
			startedAt: new Date(Date.now() - 1000).toISOString(),
		});
		updatePhaseRun(db, verifyId, {
			status: "failed",
			finishedAt: new Date().toISOString(),
		});
		reconcileSliceStatus(db, root, sliceId);
		expect(getSlice(db, sliceId)?.status).toBe("executing");
	});

	it("duplicate reconcile calls produce stable slice.status", () => {
		insertPhaseRun(db, {
			sliceId,
			phase: "plan",
			status: "started",
			startedAt: new Date().toISOString(),
		});
		reconcileSliceStatus(db, root, sliceId);
		reconcileSliceStatus(db, root, sliceId);
		reconcileSliceStatus(db, root, sliceId);
		expect(getSlice(db, sliceId)?.status).toBe("planning");
	});
});
