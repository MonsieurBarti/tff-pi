import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { handleTransition } from "../../../src/tools/transition.js";
import { must } from "../../helpers.js";

function makeFakePi(opts: { swallow?: boolean } = {}): ExtensionAPI {
	return {
		events: {
			emit: (_ch: string, _d: unknown) => {
				if (opts.swallow) return;
			},
			on: () => () => {},
		},
	} as unknown as ExtensionAPI;
}

describe("handleTransition persistence check", () => {
	let db: Database.Database;
	let sliceId: string;
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-transition-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, {
			milestoneId,
			number: 1,
			title: "Auth",
		});
		sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);
	});

	it("returns success with persistenceVerified=true when root is provided", () => {
		const pi = makeFakePi();
		const result = handleTransition(pi, db, sliceId, 1, "verifying", root);

		expect(result.isError).toBeUndefined();
		expect(result.details.persistenceVerified).toBe(true);

		const after = must(getSlice(db, sliceId));
		expect(after.status).toBe("verifying");
	});

	it("returns isError when root is absent", () => {
		const pi = makeFakePi({ swallow: true });
		const result = handleTransition(pi, db, sliceId, 1, "verifying");

		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toMatch(/no project root/i);
	});
});

describe("handleTransition with real bus (no logger needed)", () => {
	it("returns success with persistenceVerified=true when root is provided", () => {
		const root = mkdtempSync(join(tmpdir(), "tff-transition-happy-"));
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
		const db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		db.prepare("UPDATE slice SET status = 'executing' WHERE id = ?").run(sliceId);

		const pi = {
			events: {
				emit: () => {},
				on: () => () => {},
			},
		} as unknown as ExtensionAPI;

		const result = handleTransition(pi, db, sliceId, 1, "verifying", root);

		expect(result.isError).toBeUndefined();
		expect(result.details.persistenceVerified).toBe(true);

		const after = must(getSlice(db, sliceId));
		expect(after.status).toBe("verifying");

		db.close();
		rmSync(root, { recursive: true, force: true });
	});
});
