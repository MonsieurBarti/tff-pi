import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runStateRename } from "../../../src/commands/state-rename.js";
import type { TffContext } from "../../../src/common/context.js";
import { applyMigrations, insertProject } from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";

// Enable state branches
vi.mock("../../../src/common/state-branch-toggle.js", () => ({
	isStateBranchEnabledForRoot: vi.fn().mockReturnValue(true),
}));

// Stub project-home: readProjectIdFile returns a fixed id
vi.mock("../../../src/common/project-home.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/project-home.js")>();
	return {
		...actual,
		readProjectIdFile: vi.fn().mockReturnValue("proj-sr-123"),
		projectHomeDir: vi.fn().mockReturnValue("/tmp/tff-sr-home"),
	};
});

// Stub repo-state: old code branch is "main", write is a no-op
vi.mock("../../../src/common/repo-state.js", () => ({
	readRepoState: vi.fn().mockReturnValue({ lastKnownCodeBranch: "main" }),
	writeRepoState: vi.fn(),
}));

// Stub state-branch helpers
vi.mock("../../../src/common/state-branch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/state-branch.js")>();
	return {
		...actual,
		pushWithRebaseRetry: vi.fn().mockResolvedValue(undefined),
		stateBranchName: vi.fn().mockImplementation((codeBranch: string) => `tff-state/${codeBranch}`),
	};
});

// Stub git-internal so branch checks/renames succeed
vi.mock("../../../src/common/git-internal.js", () => ({
	localBranchExists: vi.fn().mockImplementation((_root: string, branch: string) => {
		// source branch exists, destination does not
		return branch === "tff-state/main";
	}),
	remoteBranchExists: vi.fn().mockReturnValue(false),
	hasOriginRemote: vi.fn().mockReturnValue(false),
	runGit: vi.fn().mockReturnValue({ ok: true, stdout: "", stderr: "" }),
}));

// Stub logger
vi.mock("../../../src/common/logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/logger.js")>();
	return {
		...actual,
		logException: vi.fn(),
	};
});

function makePi(sendUserMessage = vi.fn()) {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage,
	} as unknown as Parameters<typeof runStateRename>[0];
}

describe("runStateRename — event log (state-rename)", () => {
	let db: Database.Database;
	let root: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-sr-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });
		// Need a project row for updateLogCursor to work
		insertProject(db, { id: "p1", name: "P", vision: "V" });
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	function makeCtx(): TffContext {
		return {
			db,
			projectRoot: root,
			settings: null,
			fffBridge: null,
			perSliceLog: null,
			toolCallLogger: null,
			tuiMonitor: null,
			cmdCtx: null,
			initError: null,
		};
	}

	test("appends state-rename event and advances cursor", async () => {
		const sendMsg = vi.fn();
		await runStateRename(makePi(sendMsg), makeCtx(), null, ["feature/new-branch"]);

		// Should complete with success message, not an error
		const calls = sendMsg.mock.calls.map((c) => c[0] as string);
		const errorCall = calls.find((m) => m.startsWith("Error:"));
		expect(errorCall).toBeUndefined();

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("state-rename");
		expect(events[0]?.params).toMatchObject({
			projectId: "proj-sr-123",
			oldCodeBranch: "main",
			newCodeBranch: "feature/new-branch",
			oldStateBranch: "tff-state/main",
			newStateBranch: "tff-state/feature/new-branch",
		});

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});
});
