import { describe, expect, it } from "vitest";
import type { PhaseContext, PhaseModule, PhaseResult } from "../../../src/common/phase.js";

describe("PhaseModule interface", () => {
	it("allows implementing a phase module with run()", async () => {
		const mockModule: PhaseModule = {
			run: async (_ctx: PhaseContext): Promise<PhaseResult> => {
				return { success: true, retry: false };
			},
		};
		const result = await mockModule.run({} as PhaseContext);
		expect(result.success).toBe(true);
		expect(result.retry).toBe(false);
	});

	it("supports error and feedback in PhaseResult", async () => {
		const mockModule: PhaseModule = {
			run: async (_ctx: PhaseContext): Promise<PhaseResult> => {
				return { success: false, retry: true, error: "AC failed", feedback: "Fix auth logic" };
			},
		};
		const result = await mockModule.run({} as PhaseContext);
		expect(result.success).toBe(false);
		expect(result.retry).toBe(true);
		expect(result.error).toBe("AC failed");
		expect(result.feedback).toBe("Fix auth logic");
	});
});
