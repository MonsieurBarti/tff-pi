import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	StateBranchError,
	mirrorPortableSubset,
	stateBranchName,
} from "../../../src/common/state-branch.js";

describe("stateBranchName", () => {
	it("prefixes with tff-state/", () => {
		expect(stateBranchName("main")).toBe("tff-state/main");
	});
	it("preserves slashes in code branch names", () => {
		expect(stateBranchName("feature/M10")).toBe("tff-state/feature/M10");
	});
	it("handles ticket-style names (mb/lin-1234)", () => {
		expect(stateBranchName("mb/lin-1234-portable-state")).toBe(
			"tff-state/mb/lin-1234-portable-state",
		);
	});
});

describe("StateBranchError", () => {
	it("has a .name of StateBranchError", () => {
		const e = new StateBranchError("boom");
		expect(e.name).toBe("StateBranchError");
		expect(e).toBeInstanceOf(Error);
	});
});

describe("mirrorPortableSubset", () => {
	let home: string;
	let work: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sb-home-"));
		work = mkdtempSync(join(tmpdir(), "sb-work-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	it("copies settings.yaml and milestones/**/*.md", () => {
		writeFileSync(join(home, "settings.yaml"), "k: v\n");
		mkdirSync(join(home, "milestones", "M01", "slices", "M01-S01"), { recursive: true });
		writeFileSync(join(home, "milestones", "M01", "slices", "M01-S01", "plan.md"), "# plan\n");
		mirrorPortableSubset(home, work);
		expect(readFileSync(join(work, "settings.yaml"), "utf-8")).toBe("k: v\n");
		expect(
			readFileSync(join(work, "milestones", "M01", "slices", "M01-S01", "plan.md"), "utf-8"),
		).toBe("# plan\n");
	});

	it("excludes state.db, logs/, session.lock, .tmp/, worktrees/, repo-path, repo-state.json, .gitconfig, pending-phase-message.txt", () => {
		writeFileSync(join(home, "state.db"), "binary");
		writeFileSync(join(home, "state.db-wal"), "wal");
		mkdirSync(join(home, "logs"), { recursive: true });
		writeFileSync(join(home, "logs", "M01-S01.jsonl"), "{}\n");
		writeFileSync(join(home, "session.lock"), "{}");
		mkdirSync(join(home, ".tmp"), { recursive: true });
		writeFileSync(join(home, ".tmp", "x"), "x");
		mkdirSync(join(home, "worktrees"), { recursive: true });
		writeFileSync(join(home, "worktrees", "wt"), "wt");
		writeFileSync(join(home, "repo-path"), "/x");
		writeFileSync(join(home, "repo-state.json"), "{}");
		writeFileSync(join(home, ".gitconfig"), "[x]");
		writeFileSync(join(home, "pending-phase-message.txt"), "hi");
		mirrorPortableSubset(home, work);
		for (const f of [
			"state.db",
			"state.db-wal",
			"logs",
			"session.lock",
			".tmp",
			"worktrees",
			"repo-path",
			"repo-state.json",
			".gitconfig",
			"pending-phase-message.txt",
		]) {
			expect(() => readFileSync(join(work, f)), `${f} should be excluded`).toThrow();
		}
	});

	it("copies branch-meta.json if present", () => {
		writeFileSync(join(home, "branch-meta.json"), '{"stateId":"x"}');
		mirrorPortableSubset(home, work);
		expect(readFileSync(join(work, "branch-meta.json"), "utf-8")).toBe('{"stateId":"x"}');
	});

	it("skips symlinks that resolve to a directory without throwing", () => {
		const linkedDir = mkdtempSync(join(tmpdir(), "sb-linked-dir-"));
		writeFileSync(join(linkedDir, "inside.txt"), "content\n");
		mkdirSync(join(home, "milestones"), { recursive: true });
		symlinkSync(linkedDir, join(home, "milestones", "linked-dir"));
		// Must not throw even though the symlink target is a directory.
		expect(() => mirrorPortableSubset(home, work)).not.toThrow();
		// The symlink-to-directory is skipped, so its contents are not mirrored.
		expect(() => readFileSync(join(work, "milestones", "linked-dir", "inside.txt"))).toThrow();
		rmSync(linkedDir, { recursive: true, force: true });
	});

	it("rejects symlinks that resolve outside the home dir", () => {
		const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
		writeFileSync(join(outside, "secret"), "nope");
		mkdirSync(join(home, "milestones"), { recursive: true });
		symlinkSync(join(outside, "secret"), join(home, "milestones", "leak.md"));
		mirrorPortableSubset(home, work);
		expect(() => readFileSync(join(work, "milestones", "leak.md"))).toThrow();
		rmSync(outside, { recursive: true, force: true });
	});
});
