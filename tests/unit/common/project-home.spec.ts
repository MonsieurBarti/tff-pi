import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSnapshotMergeDriver } from "../../../src/common/project-home.js";

describe("ensureSnapshotMergeDriver", () => {
	let repo: string;
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "tff-mergedriver-"));
		execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	function configValue(key: string): string | undefined {
		try {
			return execFileSync("git", ["-C", repo, "config", "--local", "--get", key], {
				encoding: "utf-8",
			}).trim();
		} catch {
			return undefined;
		}
	}

	it("writes merge.tff-snapshot.driver when absent", () => {
		expect(configValue("merge.tff-snapshot.driver")).toBeUndefined();
		ensureSnapshotMergeDriver(repo);
		const driver = configValue("merge.tff-snapshot.driver");
		expect(driver).toBeDefined();
		expect(driver).toContain("state-snapshot-merge");
		expect(driver).toContain("%O %A %B %P");
		expect(configValue("merge.tff-snapshot.name")).toBe("TFF state snapshot 3-way merge");
	});

	it("is idempotent — second call does not modify", () => {
		ensureSnapshotMergeDriver(repo);
		const first = configValue("merge.tff-snapshot.driver");
		ensureSnapshotMergeDriver(repo);
		expect(configValue("merge.tff-snapshot.driver")).toBe(first);
	});

	it("rewrites a stale driver path", () => {
		execFileSync(
			"git",
			[
				"-C",
				repo,
				"config",
				"--local",
				"merge.tff-snapshot.driver",
				"node /stale/path.js %O %A %B %P",
			],
			{ stdio: "ignore" },
		);
		ensureSnapshotMergeDriver(repo);
		const driver = configValue("merge.tff-snapshot.driver");
		expect(driver).not.toContain("/stale/path.js");
		expect(driver).toContain("state-snapshot-merge");
	});
});
