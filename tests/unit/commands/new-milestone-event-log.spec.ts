import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMilestone } from "../../../src/commands/new-milestone.js";
import { applyMigrations, getMilestone, insertProject } from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";

vi.mock("../../../src/common/git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/git.js")>();
	return {
		...actual,
		branchExists: vi.fn().mockReturnValue(false),
		getCurrentBranch: vi.fn().mockReturnValue("main"),
		createBranch: vi.fn(),
		pushBranch: vi.fn(),
	};
});

vi.mock("../../../src/common/artifacts.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/artifacts.js")>();
	return {
		...actual,
		initMilestoneDir: vi.fn(),
		writeArtifact: vi.fn(),
	};
});

describe("createMilestone — event log", () => {
	let db: Database.Database;
	let root: string;
	let projectId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-nm-el-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		projectId = insertProject(db, { id: "p1", name: "P", vision: "V" });
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("appends create-milestone event, creates DB row, advances cursor", () => {
		const result = createMilestone(db, root, projectId, "Auth Feature");

		expect(result.milestoneId).toBeDefined();
		expect(result.number).toBe(1);

		const stored = getMilestone(db, result.milestoneId);
		expect(stored).not.toBeNull();
		expect(stored?.name).toBe("Auth Feature");

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("create-milestone");
		expect(events[0]?.params).toMatchObject({
			id: result.milestoneId,
			projectId,
			number: 1,
			name: "Auth Feature",
		});

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});

	test("each milestone gets its own event; cursor advances to total count", () => {
		createMilestone(db, root, projectId, "First");
		const result2 = createMilestone(db, root, projectId, "Second");

		expect(result2.number).toBe(2);

		const events = readEvents(root);
		expect(events).toHaveLength(2);
		expect(events[1]?.cmd).toBe("create-milestone");
		expect(events[1]?.params.name).toBe("Second");

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(2);
	});
});
