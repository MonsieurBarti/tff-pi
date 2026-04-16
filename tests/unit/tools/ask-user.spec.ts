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

	it("rejects header longer than 32 chars", () => {
		const result = validateQuestions([{ ...valid, header: "X".repeat(33) }]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("exceeds 32 characters");
	});

	it("rejects fewer than 2 options", () => {
		const result = validateQuestions([
			{ ...valid, options: [{ label: "S", description: "Simple" }] },
		]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("minimum is 2");
	});

	it("rejects more than 5 options for single-select", () => {
		const result = validateQuestions([
			{
				...valid,
				options: [
					{ label: "A", description: "" },
					{ label: "B", description: "" },
					{ label: "C", description: "" },
					{ label: "D", description: "" },
					{ label: "E", description: "" },
					{ label: "F", description: "" },
				],
			},
		]);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("single-select allows at most 5");
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

	it("accepts 5-option single-select", () => {
		expect(
			validateQuestions([
				{
					...valid,
					options: [
						{ label: "A", description: "" },
						{ label: "B", description: "" },
						{ label: "C", description: "" },
						{ label: "D", description: "" },
						{ label: "E", description: "" },
					],
				},
			]),
		).toBeNull();
	});

	it("accepts a 32-char header", () => {
		expect(validateQuestions([{ ...valid, header: "X".repeat(32) }])).toBeNull();
	});

	it("accepts >5 options when allowMultiple is true", () => {
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
						{ label: "E", description: "" },
						{ label: "F", description: "" },
					],
				},
			]),
		).toBeNull();
	});
});
