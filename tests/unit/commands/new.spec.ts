import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInit } from "../../../src/commands/init.js";
import { handleNew, runNew } from "../../../src/commands/new.js";
import { artifactExists, readArtifact } from "../../../src/common/artifacts.js";
import { createTffContext } from "../../../src/common/context.js";
import { applyMigrations, getMilestones, getProject } from "../../../src/common/db.js";
import { readProjectIdFile } from "../../../src/common/project-home.js";
import { must } from "../../helpers.js";

// Mock fff-integration so initFffBridge doesn't hit the real FS/subprocess
vi.mock("../../../src/common/fff-integration.js", () => ({
	initFffBridge: vi.fn().mockResolvedValue(null),
	shutdownFffBridge: vi.fn().mockResolvedValue(undefined),
}));

function createTestDb(): Database.Database {
	const db = new Database(":memory:");
	applyMigrations(db);
	return db;
}

describe("handleNew", () => {
	let db: Database.Database;
	let root: string;
	let tffHome: string;
	let savedTffHome: string | undefined;

	beforeEach(() => {
		savedTffHome = process.env.TFF_HOME;
		tffHome = mkdtempSync(join(tmpdir(), "tff-home-new-test-"));
		process.env.TFF_HOME = tffHome;
		db = createTestDb();
		root = mkdtempSync(join(tmpdir(), "tff-new-test-"));
		execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
		handleInit(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(tffHome, { recursive: true, force: true });
		if (savedTffHome !== undefined) process.env.TFF_HOME = savedTffHome;
		else Reflect.deleteProperty(process.env, "TFF_HOME");
	});

	it("creates a project with name and vision", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		const project = must(getProject(db));
		expect(project.name).toBe("TFF");
		expect(project.vision).toBe("Make coding great");
	});

	it("writes PROJECT.md artifact", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		expect(artifactExists(root, "PROJECT.md")).toBe(true);
		const content = readArtifact(root, "PROJECT.md");
		expect(content).toContain("TFF");
		expect(content).toContain("Make coding great");
	});

	it("does NOT create milestones", () => {
		const result = handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		const project = must(getProject(db));
		const milestones = getMilestones(db, project.id);
		expect(milestones).toHaveLength(0);
		expect(result.projectId).toBeDefined();
		expect(typeof result.projectId).toBe("string");
	});

	it("returns projectId", () => {
		const result = handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		expect(result.projectId).toBeDefined();
		expect(typeof result.projectId).toBe("string");
	});

	it("throws if project already exists", () => {
		handleNew(db, root, {
			projectName: "TFF",
			vision: "Make coding great",
		});

		expect(() =>
			handleNew(db, root, {
				projectName: "TFF",
				vision: "Another vision",
			}),
		).toThrow("Project already exists. Use /tff new-milestone to add milestones.");
	});
});

// ---------------------------------------------------------------------------
// runNew — EventLogger wiring
// ---------------------------------------------------------------------------

type Handler = (data: unknown) => void;

function makeMockEventBus() {
	const handlers = new Map<string, Handler[]>();
	return {
		on(channel: string, handler: Handler) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const updated = handlers.get(channel) ?? [];
				const idx = updated.indexOf(handler);
				if (idx !== -1) updated.splice(idx, 1);
			};
		},
		emit(channel: string, data: unknown) {
			for (const h of handlers.get(channel) ?? []) h(data);
		},
	};
}

function makeMockPi() {
	const bus = makeMockEventBus();
	const pi = {
		events: bus,
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof runNew>[0];
	return { pi, bus };
}

describe("runNew — PerSliceLog wiring", () => {
	let root: string;
	let tffHome: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Isolate git env to avoid worktree/lefthook interference
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedEnv[key] = process.env[key];
				delete process.env[key];
			}
		}
		// Isolate TFF_HOME so handleInit doesn't pollute the real ~/.tff
		savedEnv.TFF_HOME = process.env.TFF_HOME;
		tffHome = mkdtempSync(join(tmpdir(), "tff-home-test-"));
		process.env.TFF_HOME = tffHome;

		root = mkdtempSync(join(tmpdir(), "tff-runnew-test-"));
		execSync("git init", { cwd: root, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: root, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: root, stdio: "pipe" });
		execSync("git commit --allow-empty -m 'init'", { cwd: root, stdio: "pipe" });
		process.chdir(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(tffHome, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) process.env[key] = value;
			else delete process.env[key];
		}
	});

	it("sets ctx.db and ctx.perSliceLog after runNew", async () => {
		const { pi } = makeMockPi();
		const ctx = createTffContext();

		await runNew(pi, ctx, null, ["TestProject"]);

		expect(ctx.db).toBeTruthy();
		expect(ctx.perSliceLog).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// handleNew + handleInit identity unification
// ---------------------------------------------------------------------------

describe("handleNew + handleInit identity unification", () => {
	it("project.id in DB equals .tff-project-id UUID", () => {
		const tffHome = mkdtempSync(join(tmpdir(), "tff-home-id-unify-"));
		const savedTffHome = process.env.TFF_HOME;
		process.env.TFF_HOME = tffHome;
		const root = mkdtempSync(join(tmpdir(), "tff-new-id-"));
		execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
		try {
			const init = handleInit(root);
			const db = new Database(":memory:");
			applyMigrations(db);
			const { projectId } = handleNew(db, root, { projectName: "X", vision: "V" });
			expect(projectId).toBe(init.projectId);
			expect(projectId).toBe(readProjectIdFile(root));
			db.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(tffHome, { recursive: true, force: true });
			if (savedTffHome !== undefined) process.env.TFF_HOME = savedTffHome;
			else Reflect.deleteProperty(process.env, "TFF_HOME");
		}
	});
});
