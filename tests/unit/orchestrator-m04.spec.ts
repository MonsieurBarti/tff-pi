import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/common/types.js";
import { enrichContextWithFff, loadPhaseResources } from "../../src/orchestrator.js";

const ALL_PHASES = [
	"discuss",
	"research",
	"plan",
	"execute",
	"verify",
	"review",
	"ship",
	"ship-fix",
] as const;

describe("loadPhaseResources", () => {
	it.each(ALL_PHASES)("returns agentPrompt and protocol for phase '%s' (smoke)", (phase) => {
		const result = loadPhaseResources(phase);
		expect(result).toHaveProperty("agentPrompt");
		expect(result).toHaveProperty("protocol");
		expect(typeof result.agentPrompt).toBe("string");
		expect(typeof result.protocol).toBe("string");
	});
});

function makeTask(title: string): Task {
	return {
		id: `task-${Math.random()}`,
		sliceId: "s1",
		number: 1,
		title,
		status: "open" as const,
		wave: null,
		claimedBy: null,
		createdAt: "",
	};
}

describe("enrichContextWithFff", () => {
	it("adds RELATED_FILES to context when grep returns results", async () => {
		const tasks = [makeTask("implement authentication middleware")];
		const fffBridge = {
			grep: vi.fn().mockResolvedValue([{ path: "src/auth.ts" }, { path: "src/middleware.ts" }]),
		};
		const ctx: Record<string, string> = {};

		await enrichContextWithFff(ctx, tasks, fffBridge);

		expect(ctx.RELATED_FILES).toBe("src/auth.ts\nsrc/middleware.ts");
		expect(fffBridge.grep).toHaveBeenCalledOnce();
	});

	it("does nothing when grep returns empty array", async () => {
		const tasks = [makeTask("implement database schema")];
		const fffBridge = {
			grep: vi.fn().mockResolvedValue([]),
		};
		const ctx: Record<string, string> = {};

		await enrichContextWithFff(ctx, tasks, fffBridge);

		expect(ctx.RELATED_FILES).toBeUndefined();
	});

	it("does nothing when all task words are 3 chars or fewer", async () => {
		const tasks = [makeTask("fix bug")];
		const fffBridge = {
			grep: vi.fn(),
		};
		const ctx: Record<string, string> = {};

		await enrichContextWithFff(ctx, tasks, fffBridge);

		expect(ctx.RELATED_FILES).toBeUndefined();
		expect(fffBridge.grep).not.toHaveBeenCalled();
	});

	it("silently catches errors from fffBridge.grep", async () => {
		const tasks = [makeTask("implement feature module")];
		const fffBridge = {
			grep: vi.fn().mockRejectedValue(new Error("bridge unavailable")),
		};
		const ctx: Record<string, string> = {};

		await expect(enrichContextWithFff(ctx, tasks, fffBridge)).resolves.toBeUndefined();
		expect(ctx.RELATED_FILES).toBeUndefined();
	});

	it("does nothing when tasks array is empty", async () => {
		const fffBridge = {
			grep: vi.fn(),
		};
		const ctx: Record<string, string> = {};

		await enrichContextWithFff(ctx, [], fffBridge);

		expect(ctx.RELATED_FILES).toBeUndefined();
		expect(fffBridge.grep).not.toHaveBeenCalled();
	});

	it("passes at most 5 word patterns to grep", async () => {
		const tasks = [makeTask("implement alpha beta gamma delta epsilon zeta")];
		const fffBridge = {
			grep: vi.fn().mockResolvedValue([]),
		};
		const ctx: Record<string, string> = {};

		await enrichContextWithFff(ctx, tasks, fffBridge);

		const [patterns] = fffBridge.grep.mock.calls[0] as [string[], unknown];
		expect(patterns.length).toBeLessThanOrEqual(5);
	});
});
