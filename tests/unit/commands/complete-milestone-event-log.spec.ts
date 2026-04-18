import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleCompleteMilestone } from "../../../src/commands/complete-milestone.js";
import {
	applyMigrations,
	getMilestone,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";
import { must } from "../../helpers.js";

// Stub git subprocess calls
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: vi.fn().mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
				return "https://github.com/org/repo.git";
			}
			return "";
		}),
	};
});

// Stub PR tool creation
vi.mock("../../../src/common/gh-client.js", () => ({
	getPrTools: vi.fn().mockReturnValue({
		view: vi.fn().mockResolvedValue({ code: 0, stdout: '{"state":"OPEN"}', stderr: "" }),
		create: vi.fn().mockResolvedValue({
			code: 0,
			stdout: "https://github.com/org/repo/pull/99",
			stderr: "",
		}),
	}),
}));

// Stub artifact reads so all required artifacts exist
vi.mock("../../../src/common/artifacts.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/artifacts.js")>();
	return {
		...actual,
		readArtifact: vi.fn().mockReturnValue("content"),
	};
});

// Stub git helpers that check branches/defaults
vi.mock("../../../src/common/git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/git.js")>();
	return {
		...actual,
		getDefaultBranch: vi.fn().mockReturnValue("main"),
		gitEnv: vi.fn().mockReturnValue({}),
	};
});

function makePi() {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof handleCompleteMilestone>[4];
}

describe("handleCompleteMilestone — event log (complete-milestone-changes)", () => {
	let db: Database.Database;
	let root: string;
	let milestoneId: string;
	let sliceId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-cm-el-"));
		mkdirSync(join(root, ".tff"), { recursive: true });

		const projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
		milestoneId = insertMilestone(db, {
			id: "m1",
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/m01",
		});
		sliceId = insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		// Mark slice closed so the milestone can proceed
		db.prepare("UPDATE slice SET status = 'closed' WHERE id = ?").run(sliceId);
		// Milestone in initial state (default after insert is "created")
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("appends complete-milestone-changes event, sets status completing, advances cursor", async () => {
		const { DEFAULT_SETTINGS } = await import("../../../src/common/settings.js");
		const result = await handleCompleteMilestone(db, root, milestoneId, DEFAULT_SETTINGS, makePi());

		expect(result.success).toBe(true);

		const stored = must(getMilestone(db, milestoneId));
		expect(stored.status).toBe("completing");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("complete-milestone-changes");
		expect(events[0]?.params).toMatchObject({ milestoneId });

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});
});
