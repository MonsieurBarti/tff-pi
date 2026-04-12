import { describe, expect, it } from "vitest";
import { type AskUserQuestion, handleAskUser } from "../../../src/tools/ask-user.js";
import { must } from "../../helpers.js";

function makeQuestion(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
	return {
		id: "slice_scope",
		header: "Scope",
		question: "Which scope should this slice cover?",
		options: [
			{ label: "Auth only", description: "Login + JWT validation." },
			{ label: "Auth + session", description: "Login + Redis-backed session store." },
		],
		...overrides,
	};
}

describe("handleAskUser", () => {
	it("rejects empty question list", () => {
		const result = handleAskUser([]);
		expect(result.isError).toBe(true);
	});

	it("rejects < 2 options", () => {
		const result = handleAskUser([
			makeQuestion({ options: [{ label: "only", description: "nope" }] }),
		]);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toMatch(/minimum is 2/);
	});

	it("rejects > 3 options in single-select mode", () => {
		const options = Array.from({ length: 4 }, (_, i) => ({
			label: `Option ${i}`,
			description: "x",
		}));
		const result = handleAskUser([makeQuestion({ options })]);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toMatch(/at most 3/);
	});

	it("allows more options in multi-select mode", () => {
		const options = Array.from({ length: 5 }, (_, i) => ({
			label: `Option ${i}`,
			description: "x",
		}));
		const result = handleAskUser([makeQuestion({ options, allowMultiple: true })]);
		expect(result.isError).toBeUndefined();
	});

	it("rejects header >12 chars", () => {
		const result = handleAskUser([makeQuestion({ header: "VeryLongHeaderHere" })]);
		expect(result.isError).toBe(true);
	});

	it("rejects duplicate option labels", () => {
		const result = handleAskUser([
			makeQuestion({
				options: [
					{ label: "Same", description: "a" },
					{ label: "same", description: "b" },
				],
			}),
		]);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toMatch(/duplicate option label/);
	});

	it("rejects duplicate question ids", () => {
		const result = handleAskUser([makeQuestion(), makeQuestion()]);
		expect(result.isError).toBe(true);
		expect(must(result.content[0]).text).toMatch(/Duplicate question id/);
	});

	it("injects 'None of the above' for single-select only", () => {
		const result = handleAskUser([makeQuestion()]);
		expect(result.isError).toBeUndefined();
		expect(must(result.content[0]).text).toMatch(/None of the above/);

		const multi = handleAskUser([makeQuestion({ allowMultiple: true })]);
		expect(must(multi.content[0]).text).not.toMatch(/None of the above/);
	});

	it("formats multiple questions with headers and numbered options", () => {
		const result = handleAskUser([
			makeQuestion(),
			makeQuestion({ id: "db_choice", header: "DB", question: "Which DB?" }),
		]);
		const text = must(result.content[0]).text;
		expect(text).toContain("Scope — choose one");
		expect(text).toContain("DB — choose one");
		expect(text).toMatch(/^\s*1\) Auth only/m);
		expect(text).toMatch(/^\s*2\) Auth \+ session/m);
		// No literal bold markers — breaks plain-text TUI rendering.
		expect(text).not.toContain("**");
		expect(result.details.questionCount).toBe(2);
	});
});
