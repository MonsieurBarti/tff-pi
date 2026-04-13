import { describe, expect, it } from "vitest";
import { type AskUserQuestion, validateQuestions } from "../../../src/tools/ask-user.js";

const valid: AskUserQuestion = {
	id: "tier",
	header: "Tier",
	question: "Pick a tier",
	options: [
		{ label: "S", description: "Simple" },
		{ label: "SS", description: "Standard" },
	],
};

describe("validateQuestions", () => {
	it("returns null for a valid single-select question", () => {
		expect(validateQuestions([valid])).toBeNull();
	});

	it("rejects empty questions array", () => {
		const result = validateQuestions([]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("at least one question");
	});

	it("rejects duplicate question ids", () => {
		const result = validateQuestions([valid, valid]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("Duplicate question id");
	});

	it("rejects header longer than 12 chars", () => {
		const result = validateQuestions([{ ...valid, header: "X".repeat(13) }]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("exceeds 12 characters");
	});

	it("rejects fewer than 2 options", () => {
		const result = validateQuestions([
			{ ...valid, options: [{ label: "S", description: "Simple" }] },
		]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("minimum is 2");
	});

	it("rejects more than 3 options for single-select", () => {
		const result = validateQuestions([
			{
				...valid,
				options: [
					{ label: "A", description: "" },
					{ label: "B", description: "" },
					{ label: "C", description: "" },
					{ label: "D", description: "" },
				],
			},
		]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("single-select allows at most 3");
	});

	it("allows >3 options when allowMultiple is true", () => {
		expect(
			validateQuestions([
				{
					...valid,
					allowMultiple: true,
					options: [
						{ label: "A", description: "" },
						{ label: "B", description: "" },
						{ label: "C", description: "" },
						{ label: "D", description: "" },
					],
				},
			]),
		).toBeNull();
	});

	it("rejects duplicate option labels (case-insensitive)", () => {
		const result = validateQuestions([
			{
				...valid,
				options: [
					{ label: "Same", description: "" },
					{ label: "same", description: "" },
				],
			},
		]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("duplicate option label");
	});
});
