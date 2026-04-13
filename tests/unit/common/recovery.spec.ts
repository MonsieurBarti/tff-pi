import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceStatus,
} from "../../../src/common/db.js";
import { gitEnv } from "../../../src/common/git.js";
import {
	diagnoseRecovery,
	scanForStuckSlices,
	summarizeInput,
} from "../../../src/common/recovery.js";

function getProjectId(db: Database.Database): string {
	const row = db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
	return row.id;
}

describe("recovery", () => {
	let root: string;
	let db: Database.Database;
	let savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		root = join(tmpdir(), `tff-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".tff"), { recursive: true });

		const env = gitEnv();
		execFileSync("git", ["init"], { cwd: root, env });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, env });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root, env });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root, env });

		db = openDatabase(join(root, ".tff", "state.db"));
		applyMigrations(db);
		insertProject(db, { name: "TestProj", vision: "Testing" });
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });

		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			}
		}
		savedEnv = {};
	});

	describe("scanForStuckSlices", () => {
		it("returns empty array when no slices are stuck", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			expect(scanForStuckSlices(db)).toEqual([]);
		});

		it("detects slices in transitional states", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			updateSliceStatus(db, sId, "executing");

			const stuck = scanForStuckSlices(db);
			expect(stuck).toHaveLength(1);
			expect(stuck[0]?.status).toBe("executing");
		});

		it("ignores created and closed slices", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			const s2 = insertSlice(db, { milestoneId: mId, number: 2, title: "S2" });
			updateSliceStatus(db, s2, "closed");

			expect(scanForStuckSlices(db)).toEqual([]);
		});
	});

	describe("diagnoseRecovery", () => {
		it("returns resume for discussing status", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			updateSliceStatus(db, sId, "discussing");

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.classification).toBe("resume");
		});

		it("returns manual when executing with no worktree", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			updateSliceStatus(db, sId, "executing");

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.classification).toBe("manual");
		});

		it("returns manual for shipping status", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			updateSliceStatus(db, sId, "shipping");

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.classification).toBe("manual");
		});

		it("gathers artifact evidence", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			updateSliceStatus(db, sId, "verifying");

			const sliceDir = join(root, ".tff", "milestones", "M01", "slices", "M01-S01");
			mkdirSync(sliceDir, { recursive: true });
			writeFileSync(join(sliceDir, "SPEC.md"), "spec", "utf-8");
			writeFileSync(join(sliceDir, "PLAN.md"), "plan", "utf-8");

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.evidence.artifacts).toContain("SPEC.md");
			expect(diag.evidence.artifacts).toContain("PLAN.md");
		});
	});

	describe("summarizeInput", () => {
		it("returns empty string for null or non-object input", () => {
			expect(summarizeInput("bash", null)).toBe("");
			expect(summarizeInput("bash", undefined)).toBe("");
			expect(summarizeInput("bash", "not an object")).toBe("");
			expect(summarizeInput("bash", 42)).toBe("");
		});

		it("returns the bash command, truncating at 80 chars", () => {
			expect(summarizeInput("bash", { command: "bun run test" })).toBe("bun run test");
			const long = "a".repeat(100);
			const result = summarizeInput("bash", { command: long });
			expect(result.length).toBeLessThanOrEqual(81);
			expect(result.endsWith("…")).toBe(true);
		});

		it("returns path for write/edit/notebook_edit tools", () => {
			expect(summarizeInput("write", { path: "src/foo.ts" })).toBe("src/foo.ts");
			expect(summarizeInput("edit", { file_path: "src/bar.ts" })).toBe("src/bar.ts");
			expect(summarizeInput("notebook_edit", { path: "note.ipynb" })).toBe("note.ipynb");
		});

		it("returns artifact label for tff_write_* tools", () => {
			expect(summarizeInput("tff_write_verification", { content: "..." })).toBe("VERIFICATION.md");
			expect(summarizeInput("tff_write_spec", { content: "..." })).toBe("SPEC.md");
			expect(summarizeInput("tff_write_plan", { content: "..." })).toBe("PLAN.md");
		});

		it("falls back to truncated JSON for unknown tools with object input", () => {
			const result = summarizeInput("mystery_tool", { a: 1, b: 2 });
			expect(result).toContain("a");
			expect(result).toContain("1");
			expect(result.length).toBeLessThanOrEqual(81);
		});
	});
});
