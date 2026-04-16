import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoState, writeRepoState } from "../../../src/common/repo-state.js";

describe("repo-state.json", () => {
	let home: string;
	let savedHome: string | undefined;
	const projectId = "018f4a2b-3c5d-7e8f-9012-345678901234";

	beforeEach(() => {
		savedHome = process.env.TFF_HOME;
		home = mkdtempSync(join(tmpdir(), "tff-repo-state-"));
		process.env.TFF_HOME = home;
		mkdirSync(join(home, projectId), { recursive: true });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		if (savedHome === undefined) Reflect.deleteProperty(process.env, "TFF_HOME");
		else process.env.TFF_HOME = savedHome;
	});

	it("read returns null when file missing", () => {
		expect(readRepoState(projectId)).toBeNull();
	});

	it("write then read round-trips", () => {
		writeRepoState(projectId, { lastKnownCodeBranch: "feature/x" });
		const r = readRepoState(projectId);
		expect(r?.lastKnownCodeBranch).toBe("feature/x");
		expect(typeof r?.lastKnownCodeBranchSeenAt).toBe("string");
	});

	it("read returns null when JSON is malformed", () => {
		writeFileSync(join(home, projectId, "repo-state.json"), "not json{", "utf-8");
		expect(readRepoState(projectId)).toBeNull();
	});

	it("write rejects invalid branch names", () => {
		expect(() => writeRepoState(projectId, { lastKnownCodeBranch: "bad name;rm -rf" })).toThrow();
	});
});
