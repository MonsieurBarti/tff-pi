import { describe, expect, it } from "vitest";
import { buildReviewRequest } from "../../../src/common/plannotator-review.js";

describe("buildReviewRequest", () => {
	it("builds a plan-review request payload", () => {
		const request = buildReviewRequest(
			"review-123",
			"/path/to/SPEC.md",
			"# My Spec\n\nContent here",
			"spec",
		);
		expect(request.requestId).toBe("review-123");
		expect(request.action).toBe("plan-review");
		expect(request.payload.planContent).toBe("# My Spec\n\nContent here");
		expect(request.payload.planFilePath).toBe("/path/to/SPEC.md");
	});

	it("sets action to plan-review for both spec and plan types", () => {
		const specReq = buildReviewRequest("r1", "/SPEC.md", "content", "spec");
		const planReq = buildReviewRequest("r2", "/PLAN.md", "content", "plan");
		expect(specReq.action).toBe("plan-review");
		expect(planReq.action).toBe("plan-review");
	});
});
