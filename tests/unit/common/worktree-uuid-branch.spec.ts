import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, removeWorktree } from "../../../src/common/worktree.js";

describe("worktree — UUID branch", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tff-wt-uuid-"));
		execFileSync("git", ["init", "-q", "-b", "main", tmp]);
		execFileSync("git", ["-C", tmp, "config", "user.email", "t@x"]);
		execFileSync("git", ["-C", tmp, "config", "user.name", "t"]);
		execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "init"]);
		writeFileSync(join(tmp, ".tff-project-id"), "11111111-2222-4333-8444-555555555555");
	});

	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it("createWorktree creates a UUID-form slice branch and removeWorktree cleans it up", () => {
		const slice = { id: "deadbeef00000000aaaaaaaaaaaaaaaa" };
		execFileSync("git", ["-C", tmp, "checkout", "-b", "milestone/abc12345"]);
		execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "-m", "m"]);
		execFileSync("git", ["-C", tmp, "checkout", "main"]);

		const wtPath = createWorktree(tmp, "M01-S01", slice, "milestone/abc12345");
		expect(wtPath).toMatch(/\.tff\/worktrees\/M01-S01$/);

		const branches = execFileSync("git", ["-C", tmp, "branch", "--list"], { encoding: "utf-8" });
		expect(branches).toContain("slice/deadbeef");

		removeWorktree(tmp, "M01-S01", slice);
		const after = execFileSync("git", ["-C", tmp, "branch", "--list"], { encoding: "utf-8" });
		expect(after).not.toContain("slice/deadbeef");
	});
});
