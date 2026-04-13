import { describe, expect, it, vi } from "vitest";
import { fetchReviewFeedback } from "../../../src/common/review-feedback.js";

describe("fetchReviewFeedback", () => {
	const prUrl = "https://github.com/org/repo/pull/42";

	it("builds markdown from reviews + inline comments", () => {
		const fetcher = vi.fn().mockReturnValue(
			JSON.stringify({
				reviews: [
					{
						author: { login: "alice" },
						state: "CHANGES_REQUESTED",
						body: "Please rename the function.",
					},
					{ author: { login: "bot" }, state: "COMMENTED", body: "" }, // filtered
				],
				comments: [
					{
						author: { login: "bob" },
						body: "typo on L10",
						path: "src/foo.ts",
						line: 10,
					},
					{
						author: { login: "carol" },
						body: "general comment",
					},
				],
			}),
		);

		const result = fetchReviewFeedback(prUrl, fetcher);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.commentCount).toBe(3);
		expect(result.markdown).toContain("## Reviews");
		expect(result.markdown).toContain("### @alice — CHANGES_REQUESTED");
		expect(result.markdown).toContain("Please rename the function.");
		expect(result.markdown).toContain("## Inline Comments");
		expect(result.markdown).toContain("- @bob src/foo.ts:10: typo on L10");
		expect(result.markdown).toContain("- @carol: general comment");
		expect(fetcher).toHaveBeenCalledWith("org/repo", 42);
	});

	it("returns null when PR has no comments", () => {
		const fetcher = vi.fn().mockReturnValue(JSON.stringify({ reviews: [], comments: [] }));
		expect(fetchReviewFeedback(prUrl, fetcher)).toBeNull();
	});

	it("returns null when fetcher returns null (gh failure)", () => {
		const fetcher = vi.fn().mockReturnValue(null);
		expect(fetchReviewFeedback(prUrl, fetcher)).toBeNull();
	});

	it("returns null when URL is not a github PR url", () => {
		const fetcher = vi.fn();
		expect(fetchReviewFeedback("not a url", fetcher)).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("returns null when payload is invalid JSON", () => {
		const fetcher = vi.fn().mockReturnValue("not json");
		expect(fetchReviewFeedback(prUrl, fetcher)).toBeNull();
	});

	it("joins multiline inline-comment bodies into a single line", () => {
		const fetcher = vi.fn().mockReturnValue(
			JSON.stringify({
				reviews: [],
				comments: [
					{
						author: { login: "dave" },
						body: "line1\nline2",
					},
				],
			}),
		);
		const result = fetchReviewFeedback(prUrl, fetcher);
		expect(result?.markdown).toContain("- @dave: line1 line2");
	});
});
