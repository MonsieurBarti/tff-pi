import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCompleteMilestoneMerged } from "../../../src/commands/complete-milestone-merged.js";
import { handleInit } from "../../../src/commands/init.js";
import {
	applyMigrations,
	getMilestone,
	insertProject,
	openDatabase,
} from "../../../src/common/db.js";
import * as stateShip from "../../../src/common/state-ship.js";

describe("handleCompleteMilestoneMerged", () => {
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
		homeDir = mkdtempSync(join(tmpdir(), "tff-s4-cmm-home-"));
		process.env.TFF_HOME = homeDir;
		dir = mkdtempSync(join(tmpdir(), "tff-s4-cmm-repo-"));
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

	function seedMilestone(status: "in_progress" | "completing" | "closed" = "completing") {
		const realDbPath = join(dir, ".pi", ".tff", "state.db");
		const realDb = openDatabase(realDbPath);
		applyMigrations(realDb, { root: dir });
		insertProject(realDb, { name: "p", vision: "v" });
		const projRow = realDb.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
		realDb
			.prepare(
				"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("M10", projRow.id, 10, "Test", status, "milestone/M10");
		return realDb;
	}

	const fakePi = {
		events: { emit: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleCompleteMilestoneMerged>[0];

	it("refuses when milestone is not in 'completing' status", async () => {
		const db = seedMilestone("in_progress");
		const result = await handleCompleteMilestoneMerged(fakePi, db, dir, "M10");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/not.*completing|complete-milestone first/i);
		db.close();
	});

	it("closes milestone on 'finalized' outcome", async () => {
		vi.spyOn(stateShip, "finalizeStateBranchForMilestone").mockResolvedValue("finalized");
		const db = seedMilestone("completing");
		const result = await handleCompleteMilestoneMerged(fakePi, db, dir, "M10");
		expect(result.success).toBe(true);
		expect(getMilestone(db, "M10")?.status).toBe("closed");
		db.close();
	});

	it("leaves status 'completing' on 'conflict-backup' outcome", async () => {
		vi.spyOn(stateShip, "finalizeStateBranchForMilestone").mockResolvedValue("conflict-backup");
		const db = seedMilestone("completing");
		const result = await handleCompleteMilestoneMerged(fakePi, db, dir, "M10");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/conflict|backup/i);
		expect(getMilestone(db, "M10")?.status).toBe("completing");
		db.close();
	});

	it("is idempotent: returns failure with 'already closed' when already closed", async () => {
		const db = seedMilestone("closed");
		const result = await handleCompleteMilestoneMerged(fakePi, db, dir, "M10");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/already closed/i);
		db.close();
	});
});
