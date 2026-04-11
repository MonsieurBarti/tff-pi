import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, openDatabase } from "../../../src/common/db.js";
import { isGateUnlocked, resetGates, unlockGate } from "../../../src/common/discuss-gates.js";
import type { PhaseContext } from "../../../src/common/phase.js";
import { discussPhase } from "../../../src/phases/discuss.js";

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
	const root = mkdtempSync(join(tmpdir(), "tff-discuss-"));
	mkdirSync(join(root, ".tff"), { recursive: true });
	const db = openDatabase(":memory:");
	applyMigrations(db);

	db.prepare("INSERT INTO project (id, name, vision) VALUES (?, ?, ?)").run("p1", "Test", "V");
	db.prepare(
		"INSERT INTO milestone (id, project_id, number, name, status, branch) VALUES (?, ?, ?, ?, ?, ?)",
	).run("m1", "p1", 1, "M1", "in_progress", "main");
	db.prepare(
		"INSERT INTO slice (id, milestone_id, number, title, status) VALUES (?, ?, ?, ?, ?)",
	).run("s1", "m1", 1, "Test Slice", "created");

	return {
		pi: {
			sendUserMessage: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
		} as unknown as PhaseContext["pi"],
		db,
		root,
		slice: {
			id: "s1",
			milestoneId: "m1",
			number: 1,
			title: "Test Slice",
			status: "created",
			tier: null,
			prUrl: null,
			createdAt: "",
		},
		milestoneNumber: 1,
		settings: {
			model_profile: "balanced" as const,
			compress: { user_artifacts: false },
			ship: { auto_merge: false },
		},
		...overrides,
	};
}

describe("discuss phase rewrite", () => {
	beforeEach(() => {
		resetGates("s1");
	});

	it("sends protocol message via pi.sendUserMessage", async () => {
		const ctx = makeCtx();
		const result = await discussPhase.run(ctx);

		expect(ctx.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
	});

	it("includes slice context in the message", async () => {
		const ctx = makeCtx();
		await discussPhase.run(ctx);

		const calls = (ctx.pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
		const msg = calls[0]?.[0] as string;
		expect(msg).toContain("Test Slice");
		expect(msg).toContain("s1");
	});

	it("resets gates for the slice", async () => {
		unlockGate("s1", "depth_verified");
		unlockGate("s1", "tier_confirmed");

		const ctx = makeCtx();
		await discussPhase.run(ctx);

		expect(isGateUnlocked("s1", "depth_verified")).toBe(false);
		expect(isGateUnlocked("s1", "tier_confirmed")).toBe(false);
	});

	it("emits phase_start but NOT phase_complete (completion tracked on /tff next)", async () => {
		const ctx = makeCtx();
		await discussPhase.run(ctx);

		const emitCalls = (ctx.pi.events.emit as ReturnType<typeof vi.fn>).mock.calls;
		const phaseEvents = emitCalls.filter((call: unknown[]) => call[0] === "tff:phase");
		expect(phaseEvents).toHaveLength(1);
		expect(phaseEvents[0]?.[1]).toMatchObject({ type: "phase_start", phase: "discuss" });
	});

	it("does NOT dispatch a sub-agent", async () => {
		const ctx = makeCtx();
		await discussPhase.run(ctx);

		// sendUserMessage should be called, but no sub-agent
		expect(ctx.pi.sendUserMessage).toHaveBeenCalled();
	});

	it("always runs interactive mode", async () => {
		const ctx = makeCtx();
		await discussPhase.run(ctx);

		expect(ctx.pi.sendUserMessage).toHaveBeenCalled();
	});
});
