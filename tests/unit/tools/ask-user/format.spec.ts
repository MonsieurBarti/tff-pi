import { describe, expect, it } from "vitest";
import { formatForLLM } from "../../../../src/tools/ask-user/format.js";
import type { RoundResult } from "../../../../src/tools/ask-user/interview-ui.js";

describe("formatForLLM", () => {
	it("renders single-select answer with label", () => {
		const result: RoundResult = {
			endInterview: false,
			answers: {
				tier_choice: { selected: "SS (recommended)", notes: "" },
			},
		};
		expect(formatForLLM(result)).toBe("User answers:\n- tier_choice: SS (recommended)");
	});

	it("renders multi-select answer with comma-joined labels", () => {
		const result: RoundResult = {
			endInterview: false,
			answers: {
				features: { selected: ["auth", "billing"], notes: "" },
			},
		};
		expect(formatForLLM(result)).toBe("User answers:\n- features: auth, billing");
	});

	it("includes notes line when notes present", () => {
		const result: RoundResult = {
			endInterview: false,
			answers: {
				spec_ready: { selected: "Yes, write spec", notes: "but include error codes too" },
			},
		};
		expect(formatForLLM(result)).toBe(
			"User answers:\n- spec_ready: Yes, write spec\n  Notes: but include error codes too",
		);
	});

	it("renders empty answers as 'No answers'", () => {
		const result: RoundResult = { endInterview: false, answers: {} };
		expect(formatForLLM(result)).toBe("User answers: (none)");
	});
});
