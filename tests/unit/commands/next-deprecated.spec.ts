import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../../src/commands/registry.js";
import type { TffContext } from "../../../src/common/context.js";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
	updateSliceTier,
} from "../../../src/common/db.js";
import { must } from "../../helpers.js";

function makePi(): ExtensionAPI {
	return {
		events: { emit: vi.fn(), on: vi.fn() },
		sendUserMessage: vi.fn(),
		exec: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
}

describe("/tff next deprecation stub", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		updateSliceTier(db, sliceId, "SS");
		db.prepare("UPDATE slice SET status = 'planning' WHERE id = ?").run(sliceId);
	});

	it("is registered as a command", () => {
		expect(COMMANDS.has("next")).toBe(true);
	});

	it("prints the current hint + deprecation note, does not throw", async () => {
		const pi = makePi();
		const handler = COMMANDS.get("next");
		expect(handler).toBeDefined();
		if (!handler) return;
		// Build a TffContext minimally — adjust fields per src/common/context.ts TffContext definition
		const ctx = {
			db,
			projectRoot: "/root",
			settings: null,
			initError: null,
			fffBridge: null,
			eventLogger: null,
			tuiMonitor: null,
			toolCallLogger: null,
			cmdCtx: null,
		} as unknown as TffContext;
		await handler(pi, ctx, null, []);
		const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const joined = calls.map((c) => c[0]).join(" ");
		expect(joined).toMatch(/removed/i);
	});
});
