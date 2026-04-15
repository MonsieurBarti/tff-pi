import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepoState } from "../../../src/common/repo-state.js";
import { acquireLock, releaseLock } from "../../../src/common/session-lock.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import {
	type AutoDetectAskUser,
	detectAndHandleRename,
	detectRenameAlert,
} from "../../../src/lifecycle-rename-detect.js";
import { seedEnabledSettings } from "../../helpers/settings.js";
import { type TestProject, initTestProject } from "./helpers.js";

describe("auto-detect rename", () => {
	let p: TestProject;

	beforeEach(async () => {
		p = initTestProject();
		seedEnabledSettings(p.repo);
		execSync("git checkout -b feature/alpha", { cwd: p.repo });
		await ensureStateBranch(p.repo, p.init.projectId);
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("no-op when toggle off", async () => {
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: false\n",
			"utf-8",
		);
		const ask: AutoDetectAskUser = async () => "Yes";
		const result = await detectAndHandleRename(p.repo, p.init.projectId, ask);
		expect(result).toBe("skipped-disabled");
	});

	it("no-op when auto_detect_rename=false", async () => {
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: true\n  auto_detect_rename: false\n",
			"utf-8",
		);
		const ask: AutoDetectAskUser = async () => "Yes";
		expect(await detectAndHandleRename(p.repo, p.init.projectId, ask)).toBe(
			"skipped-auto-detect-off",
		);
	});

	it("no-op when current == last-known", async () => {
		const ask: AutoDetectAskUser = async () => "Yes";
		expect(await detectAndHandleRename(p.repo, p.init.projectId, ask)).toBe("no-change");
	});

	it("silent update when old branch still exists", async () => {
		execSync("git checkout -b feature/beta", { cwd: p.repo });
		const ask: AutoDetectAskUser = async () => {
			throw new Error("should not ask");
		};
		const result = await detectAndHandleRename(p.repo, p.init.projectId, ask);
		expect(result).toBe("not-a-rename");
		expect(readRepoState(p.init.projectId)?.lastKnownCodeBranch).toBe("feature/beta");
	});

	it("prompt fires when old branch gone; Yes runs rename", async () => {
		execSync("git branch -m feature/gamma", { cwd: p.repo });
		let asked = false;
		const ask: AutoDetectAskUser = async () => {
			asked = true;
			return "Yes";
		};
		const result = await detectAndHandleRename(p.repo, p.init.projectId, ask);
		expect(asked).toBe(true);
		expect(result).toBe("renamed");
		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'", {
			cwd: p.repo,
			encoding: "utf-8",
		})
			.trim()
			.split("\n");
		expect(refs).toContain("tff-state/feature/gamma");
	});

	it("No answer updates repo-state without renaming state", async () => {
		execSync("git branch -m feature/delta", { cwd: p.repo });
		const ask: AutoDetectAskUser = async () => "No";
		const result = await detectAndHandleRename(p.repo, p.init.projectId, ask);
		expect(result).toBe("declined");
		expect(readRepoState(p.init.projectId)?.lastKnownCodeBranch).toBe("feature/delta");
		const refs = execSync("git for-each-ref refs/heads/tff-state/ --format='%(refname:short)'", {
			cwd: p.repo,
			encoding: "utf-8",
		}).trim();
		expect(refs).toContain("tff-state/feature/alpha"); // unchanged
	});

	it("Never-ask writes auto_detect_rename=false to settings", async () => {
		execSync("git branch -m feature/epsilon", { cwd: p.repo });
		const ask: AutoDetectAskUser = async () => "Never ask";
		await detectAndHandleRename(p.repo, p.init.projectId, ask);
		const yaml = readFileSync(join(p.repo, ".tff", "settings.yaml"), "utf-8");
		expect(yaml).toMatch(/auto_detect_rename:\s*false/);
	});

	it("skipped-locked when session lock is held", async () => {
		acquireLock(p.repo, { phase: "execute", sliceId: "test-slice" });
		try {
			const ask: AutoDetectAskUser = async () => {
				throw new Error("should not ask");
			};
			const result = await detectAndHandleRename(p.repo, p.init.projectId, ask);
			expect(result).toBe("skipped-locked");
		} finally {
			releaseLock(p.repo);
		}
	});
});

describe("detectRenameAlert", () => {
	let p: TestProject;

	beforeEach(async () => {
		p = initTestProject();
		seedEnabledSettings(p.repo);
		execSync("git checkout -b feature/alpha", { cwd: p.repo });
		await ensureStateBranch(p.repo, p.init.projectId);
	});
	afterEach(() => {
		p.cleanup();
		p.restoreEnv();
	});

	it("alerted when true rename candidate: emit called and repo-state updated", async () => {
		execSync("git branch -m feature/gamma", { cwd: p.repo });
		const emit = vi.fn();
		const result = await detectRenameAlert(p.repo, p.init.projectId, emit);
		expect(result).toBe("alerted");
		expect(emit).toHaveBeenCalledOnce();
		const message = emit.mock.calls[0]?.[0] as string;
		expect(message).toMatch(/^Detected branch rename: feature\/alpha -> feature\/gamma\./);
		expect(message).toContain("/tff state rename feature/gamma");
		expect(readRepoState(p.init.projectId)?.lastKnownCodeBranch).toBe("feature/gamma");
	});

	it("not-a-rename when old branch still exists: emit NOT called", async () => {
		execSync("git checkout -b feature/beta", { cwd: p.repo });
		const emit = vi.fn();
		const result = await detectRenameAlert(p.repo, p.init.projectId, emit);
		expect(result).toBe("not-a-rename");
		expect(emit).not.toHaveBeenCalled();
	});

	it("skipped-disabled when state_branch toggle is off: emit NOT called", async () => {
		writeFileSync(
			join(p.repo, ".tff", "settings.yaml"),
			"state_branch:\n  enabled: false\n",
			"utf-8",
		);
		const emit = vi.fn();
		const result = await detectRenameAlert(p.repo, p.init.projectId, emit);
		expect(result).toBe("skipped-disabled");
		expect(emit).not.toHaveBeenCalled();
	});

	it("skipped-locked when session lock is held: emit NOT called", async () => {
		acquireLock(p.repo, { phase: "execute", sliceId: "test-slice" });
		try {
			const emit = vi.fn();
			const result = await detectRenameAlert(p.repo, p.init.projectId, emit);
			expect(result).toBe("skipped-locked");
			expect(emit).not.toHaveBeenCalled();
		} finally {
			releaseLock(p.repo);
		}
	});
});
