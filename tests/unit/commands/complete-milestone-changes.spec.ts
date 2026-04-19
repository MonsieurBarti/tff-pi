import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCompleteMilestoneChanges } from "../../../src/commands/complete-milestone-changes.js";
import { handleInit } from "../../../src/commands/init.js";
import {
	applyMigrations,
	getMilestone,
	insertProject,
	openDatabase,
} from "../../../src/common/db.js";

describe("handleCompleteMilestoneChanges", () => {
	let dir: string;
	let homeDir: string;
	let savedHome: string | undefined;
	let savedGit: Record<string, string | undefined> = {};

	beforeEach(() => {
		savedGit = {};
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("GIT_")) {
				savedGit[k] = process.env[k];
				Reflect.deleteProperty(process.env, k);
			}
		}
		savedHome = process.env.TFF_HOME;
		homeDir = mkdtempSync(join(tmpdir(), "tff-s4-cmc-home-"));
		process.env.TFF_HOME = homeDir;
		dir = mkdtempSync(join(tmpdir(), "tff-s4-cmc-repo-"));
		execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
		execFileSync("git", ["config", "user.email", "a@a.com"], { cwd: dir, stdio: "pipe" });
		execFileSync("git", ["config", "user.name", "A"], { cwd: dir, stdio: "pipe" });
		execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
			cwd: dir,
			stdio: "pipe",
		});
		handleInit(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
		if (savedHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedHome;
		for (const [k, v] of Object.entries(savedGit)) if (v !== undefined) process.env[k] = v;
	});

	function seed(status: "in_progress" | "completing" = "completing") {
		const db = openDatabase(join(dir, ".pi", ".tff", "state.db"));
		applyMigrations(db, { root: dir });
		insertProject(db, { name: "p", vision: "v" });
		const p = db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
		db.prepare(
			"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
		).run("M10", p.id, 10, "Test", status, "milestone/M10");
		return db;
	}

	const fakePi = {
		events: { emit: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleCompleteMilestoneChanges>[0];

	it("writes MILESTONE_REVIEW_FEEDBACK.md and leaves status 'completing'", async () => {
		const db = seed("completing");
		const result = await handleCompleteMilestoneChanges(
			fakePi,
			db,
			dir,
			"M10",
			"Please rename X to Y.",
		);
		expect(result.success).toBe(true);
		const feedbackPath = join(
			dir,
			".pi",
			".tff",
			"milestones",
			"M10",
			"MILESTONE_REVIEW_FEEDBACK.md",
		);
		expect(existsSync(feedbackPath)).toBe(true);
		expect(readFileSync(feedbackPath, "utf-8")).toContain("Please rename X to Y.");
		expect(getMilestone(db, "M10")?.status).toBe("completing");
		db.close();
	});

	it("refuses when milestone is not in 'completing' status", async () => {
		const db = seed("in_progress");
		const result = await handleCompleteMilestoneChanges(fakePi, db, dir, "M10", "x");
		expect(result.success).toBe(false);
		db.close();
	});

	it("refuses with empty feedback", async () => {
		const db = seed("completing");
		const result = await handleCompleteMilestoneChanges(fakePi, db, dir, "M10", "   ");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/empty/i);
		db.close();
	});
});
