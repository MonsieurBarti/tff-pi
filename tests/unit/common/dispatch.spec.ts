import { describe, expect, it } from "vitest";
import { type SubAgentPrompt, buildSubagentTask } from "../../../src/common/dispatch.js";

describe("buildSubagentTask", () => {
	it("builds task from user prompt (system prompt passed separately via flag)", () => {
		const prompt: SubAgentPrompt = {
			systemPrompt: "You are a brainstormer.",
			userPrompt: "Design slice S01.",
			tools: ["tff_write_spec", "tff_classify"],
			label: "M01-S01: discuss",
		};
		const task = buildSubagentTask(prompt);
		expect(task).toContain("Design slice S01.");
		expect(task).not.toContain("You are a brainstormer.");
	});

	it("includes tool list in the task", () => {
		const prompt: SubAgentPrompt = {
			systemPrompt: "Identity.",
			userPrompt: "Do the thing.",
			tools: ["tff_write_spec", "tff_classify"],
			label: "test",
		};
		const task = buildSubagentTask(prompt);
		expect(task).toContain("tff_write_spec");
		expect(task).toContain("tff_classify");
	});
});
