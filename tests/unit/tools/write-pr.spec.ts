import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initMilestoneDir,
	initSliceDir,
	initTffDirectory,
	readArtifact,
	writeArtifact,
} from "../../../src/common/artifacts.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertPhaseRun,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { handleWritePr } from "../../../src/tools/write-pr.js";
import { must } from "../../helpers.js";

describe("handleWritePr", () => {
	let db: Database.Database;
	let root: string;
	let sliceId: string;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-write-pr-"));
		initTffDirectory(root);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		initMilestoneDir(root, 1);
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		initSliceDir(root, 1, 1);
		// Put slice in verifying state with an active verify phase_run (required by commitCommand preconditions)
		db.prepare("UPDATE slice SET status = 'verifying' WHERE id = ?").run(sliceId);
		insertPhaseRun(db, {
			sliceId,
			phase: "verify",
			status: "started",
			startedAt: new Date().toISOString(),
		});
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes PR.md by rendering the builtin template", () => {
		const result = handleWritePr(db, root, sliceId, {
			description: "Adds JWT auth",
			testSteps: "1. Run `bun test`\n2. Hit /login",
		});
		expect(result.isError).toBeUndefined();
		const pr = readArtifact(root, "milestones/M01/slices/M01-S01/PR.md");
		expect(pr).toContain("Adds JWT auth");
		expect(pr).toContain("Hit /login");
		expect(pr).toContain("PR Checklist");
		// Optional fields default to _(none)_
		expect(pr).toContain("_(none)_");
	});

	it("uses project override at .tff/templates/pr-body.md when present", () => {
		writeArtifact(root, "templates/pr-body.md", "## Custom\n\n{{description}}");
		const result = handleWritePr(db, root, sliceId, {
			description: "Adds auth",
			testSteps: "n/a",
		});
		expect(result.isError).toBeUndefined();
		const pr = readArtifact(root, "milestones/M01/slices/M01-S01/PR.md");
		expect(pr).toBe("## Custom\n\nAdds auth");
	});

	it("errors on unknown slice", () => {
		const result = handleWritePr(db, root, "nonexistent", {
			description: "x",
			testSteps: "y",
		});
		expect(result.isError).toBe(true);
	});
});
