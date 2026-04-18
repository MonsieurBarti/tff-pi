import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { handleNew } from "../../../src/commands/new.js";
import { applyMigrations, getProject } from "../../../src/common/db.js";
import { loadCursor, readEvents } from "../../../src/common/event-log.js";

describe("handleNew — event log", () => {
	let db: Database.Database;
	let root: string;
	let tffHome: string;
	let savedTffHome: string | undefined;

	beforeEach(() => {
		savedTffHome = process.env.TFF_HOME;
		tffHome = mkdtempSync(join(tmpdir(), "tff-home-cp-el-"));
		process.env.TFF_HOME = tffHome;
		db = new Database(":memory:");
		applyMigrations(db);
		root = mkdtempSync(join(tmpdir(), "tff-cp-el-"));
		execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
		handleInit(root);
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(tffHome, { recursive: true, force: true });
		if (savedTffHome !== undefined) process.env.TFF_HOME = savedTffHome;
		else Reflect.deleteProperty(process.env, "TFF_HOME");
	});

	test("appends create-project event, creates DB row, advances cursor", () => {
		const result = handleNew(db, root, { projectName: "MyProject", vision: "Do great things" });

		expect(result.projectId).toBeDefined();

		const project = getProject(db);
		expect(project).not.toBeNull();
		expect(project?.name).toBe("MyProject");
		expect(project?.vision).toBe("Do great things");
		expect(project?.id).toBe(result.projectId);

		const events = readEvents(root);
		expect(events).toHaveLength(1);
		expect(events[0]?.cmd).toBe("create-project");
		expect(events[0]?.params).toMatchObject({
			id: result.projectId,
			name: "MyProject",
			vision: "Do great things",
		});

		const cursor = loadCursor(db);
		expect(cursor.lastRow).toBe(1);
		expect(cursor.lastHash).toBe(events[0]?.hash);
	});

	test("event id matches the returned projectId", () => {
		const result = handleNew(db, root, { projectName: "P", vision: "V" });
		const events = readEvents(root);
		expect(events[0]?.params.id).toBe(result.projectId);
	});
});
