import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getEventLog,
	getMilestones,
	getProject,
	getSlice,
	getSlices,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { setLogBasePath, setStderrLoggingEnabled } from "../../../src/common/logger.js";
import { emitPhaseCompleteIfArtifactsReady } from "../../../src/common/phase-completion.js";
import type { Slice } from "../../../src/common/types.js";
import { must } from "../../helpers.js";

describe("emitPhaseCompleteIfArtifactsReady — missing artifact log", () => {
	let db: Database.Database;
	let slice: Slice;
	let auditRoot: string;
	let stderrSpy: MockInstance;

	beforeEach(() => {
		db = openDatabase(":memory:");
		applyMigrations(db);
		insertProject(db, { name: "TFF", vision: "V" });
		const projectId = must(getProject(db)).id;
		insertMilestone(db, { projectId, number: 1, name: "M1", branch: "milestone/M01" });
		const milestoneId = must(getMilestones(db, projectId)[0]).id;
		insertSlice(db, { milestoneId, number: 1, title: "Auth" });
		const sliceId = must(getSlices(db, milestoneId)[0]).id;
		slice = must(getSlice(db, sliceId)) as Slice;
		auditRoot = mkdtempSync(join(tmpdir(), "tff-pcml-"));
		setLogBasePath(auditRoot);
		setStderrLoggingEnabled(true);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		rmSync(auditRoot, { recursive: true, force: true });
	});

	it("emits one structured stderr warn line when artifacts missing; no tff:warning in event_log", () => {
		const fakePi = {
			events: { emit: vi.fn(), on: () => () => {} },
		} as unknown as ExtensionAPI;

		const verify = () => ({ ok: false, missing: ["PLAN.md", "SPEC.md"] });

		const result = emitPhaseCompleteIfArtifactsReady(
			fakePi,
			db,
			"/tmp/nonexistent",
			slice,
			"plan",
			verify,
		);

		expect(result).toBeNull();
		expect(fakePi.events.emit).not.toHaveBeenCalled();

		// Post-M12-S01: no event_log row with channel='tff:warning' is written.
		expect(getEventLog(db, slice.id, "tff:warning")).toEqual([]);

		// Assert exactly one JSON stderr line, shape = completion/phase_complete_skipped.
		const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
		const parsed = writes.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
		expect(parsed).toHaveLength(1);
		const line = parsed[0] as {
			level: string;
			component: string;
			message: string;
			ctx: { sid?: string; fn?: string; error?: string };
		};
		expect(line.level).toBe("warn");
		expect(line.component).toBe("completion");
		expect(line.message).toBe("phase_complete_skipped");
		expect(line.ctx.sid).toBe(slice.id);
		expect(line.ctx.error).toBe("PLAN.md,SPEC.md");
	});

	it("emits phase_complete normally when artifacts are ready", () => {
		const fakePi = {
			events: { emit: vi.fn(), on: () => () => {} },
		} as unknown as ExtensionAPI;
		const verify = () => ({ ok: true, missing: [] });

		const result = emitPhaseCompleteIfArtifactsReady(
			fakePi,
			db,
			"/tmp/nonexistent",
			slice,
			"plan",
			verify,
		);

		expect(fakePi.events.emit).toHaveBeenCalledTimes(1);
		expect(typeof result).toBe("string");
		expect(getEventLog(db, slice.id, "tff:warning")).toEqual([]);
	});
});
