import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMilestone } from "../../../src/commands/new-milestone.js";
import { handleStatus } from "../../../src/commands/status.js";
import {
	applyMigrations,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";

describe("M11-S4: fresh init → UUID branches end-to-end", () => {
	let tmp: string;
	let db: ReturnType<typeof openDatabase>;
	let projectId: string;
	const savedGitEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save and clear GIT_* env vars to isolate from lefthook/worktree context
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedGitEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		tmp = mkdtempSync(join(tmpdir(), "tff-m11s4-fresh-"));
		execFileSync("git", ["init", "-q", "-b", "main", tmp]);
		execFileSync("git", ["-C", tmp, "config", "user.email", "t@x"]);
		execFileSync("git", ["-C", tmp, "config", "user.name", "t"]);
		execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"]);
		// readProjectIdFile validates UUID v4 — use a real one.
		writeFileSync(join(tmp, ".tff-project-id"), "11111111-2222-4333-8444-555555555555");
		mkdirSync(join(tmp, ".pi", ".tff"), { recursive: true });
		db = openDatabase(join(tmp, "state.db"));
		applyMigrations(db, { root: tmp });
		projectId = insertProject(db, { name: "demo", vision: "v" });
	});

	afterEach(() => {
		db.close();
		rmSync(tmp, { recursive: true, force: true });
		// Restore GIT_* env vars
		for (const [key, value] of Object.entries(savedGitEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
	});

	it("milestone branch is UUID-form; status output is label-form", () => {
		const r = createMilestone(db, tmp, projectId, "milestone one");
		insertSlice(db, { milestoneId: r.milestoneId, number: 1, title: "first slice" });

		// Assert: git has the UUID-form milestone branch, not the label form.
		const branches = execFileSync("git", ["-C", tmp, "branch", "--list"], { encoding: "utf-8" });
		expect(branches).toMatch(/milestone\/[0-9a-f]{8}/);
		expect(branches).not.toContain("milestone/M01");

		// Assert: user-facing status output uses the label form, no UUID leaks.
		const status = handleStatus(db);
		expect(status).toContain("M01-S01");
		// No 8-char hex UUIDs in user-facing text. (The slice id itself is 32 chars
		// long and never appears in handleStatus output.)
		expect(status).not.toMatch(/[0-9a-f]{8}/);
	});
});
