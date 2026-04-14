import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNew, runNew } from "../../../src/commands/new.js";
import { artifactExists, readArtifact } from "../../../src/common/artifacts.js";
import { createTffContext } from "../../../src/common/context.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
} from "../../../src/common/db.js";
import { makeBaseEvent } from "../../../src/common/events.js";
import type { PhaseEvent } from "../../../src/common/events.js";
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

	beforeEach(() => {
		db = createTestDb();
		root = mkdtempSync(join(tmpdir(), "tff-new-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
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

describe("runNew — EventLogger wiring", () => {
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

	it("sets ctx.db and ctx.eventLogger after runNew", async () => {
		const { pi } = makeMockPi();
		const ctx = createTffContext();

		await runNew(pi, ctx, null, ["TestProject"]);

		expect(ctx.db).toBeTruthy();
		expect(ctx.eventLogger).toBeTruthy();
	});

	it("phase_start event reaches EventLogger and reconciles slice status to 'discussing'", async () => {
		const { pi, bus } = makeMockPi();
		const ctx = createTffContext();

		await runNew(pi, ctx, null, ["TestProject"]);

		// Seed DB with project + milestone + slice so reconcileSliceStatus has data
		// Note: runNew sets up the DB but doesn't insert a project row — that's
		// done by the tff_create_project tool. Insert manually here.
		const db = must(ctx.db);
		const projectId = insertProject(db, { name: "TestProject", vision: "V" });
		const milestoneId = insertMilestone(db, {
			projectId,
			number: 1,
			name: "M1",
			branch: "milestone/M01",
		});
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;

		// Verify initial status is "created"
		expect(must(getSlice(db, sliceId)).status).toBe("created");

		// Emit phase_start on the bus — this should reach EventLogger → reconcileSliceStatus
		const base = makeBaseEvent(sliceId, "M01-S01", 1);
		const phaseStart: PhaseEvent = {
			...base,
			type: "phase_start",
			phase: "discuss",
		};
		bus.emit("tff:phase", phaseStart);

		// Slice status should now be "discussing"
		expect(must(getSlice(db, sliceId)).status).toBe("discussing");
	});
});
