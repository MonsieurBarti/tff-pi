import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildReviewRequest, requestReview } from "../../../src/common/plannotator-review.js";

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

/**
 * Build a minimal fake ExtensionAPI.events that records emissions and exposes
 * a way to fire subscribers (simulating plannotator responding).
 */
function createFakePi(): {
	pi: ExtensionAPI;
	emissions: Array<{ channel: string; data: unknown }>;
	fire: (channel: string, data: unknown) => void;
} {
	const subscribers = new Map<string, Set<(data: unknown) => void>>();
	const emissions: Array<{ channel: string; data: unknown }> = [];

	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			let set = subscribers.get(channel);
			if (!set) {
				set = new Set();
				subscribers.set(channel, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
			};
		},
		emit(channel: string, data: unknown) {
			emissions.push({ channel, data });
		},
	};

	const fire = (channel: string, data: unknown) => {
		const set = subscribers.get(channel);
		if (!set) return;
		for (const h of set) h(data);
	};

	return { pi: { events } as unknown as ExtensionAPI, emissions, fire };
}

describe("requestReview", () => {
	it("resolves with approved=true when plannotator approves", async () => {
		const { pi, emissions, fire } = createFakePi();
		const pending = requestReview(pi, "/SPEC.md", "content", "spec");

		// Extract the emitted request to grab its requestId
		const emitted = emissions.find((e) => e.channel === "plannotator:request");
		expect(emitted).toBeDefined();
		const requestId = (emitted?.data as { requestId: string }).requestId;

		fire("plannotator:review-result", { reviewId: requestId, approved: true });

		const result = await pending;
		expect(result.approved).toBe(true);
	});

	it("resolves with approved=false when plannotator rejects", async () => {
		const { pi, emissions, fire } = createFakePi();
		const pending = requestReview(pi, "/PLAN.md", "content", "plan");
		const emitted = emissions.find((e) => e.channel === "plannotator:request");
		const requestId = (emitted?.data as { requestId: string }).requestId;

		fire("plannotator:review-result", {
			reviewId: requestId,
			approved: false,
			feedback: "needs work",
		});

		const result = await pending;
		expect(result.approved).toBe(false);
		expect(result.feedback).toBe("needs work");
	});

	it("auto-approves when plannotator reports unavailable", async () => {
		const { pi, emissions } = createFakePi();
		const pending = requestReview(pi, "/SPEC.md", "content", "spec");

		// The emitted request carries a `respond` callback; simulate unavailable.
		const emitted = emissions.find((e) => e.channel === "plannotator:request");
		const respond = (emitted?.data as { respond: (r: unknown) => void }).respond;
		respond({ status: "unavailable" });

		const result = await pending;
		expect(result.approved).toBe(true);
		expect(result.feedback).toContain("unavailable");
	});

	it("does not resolve before plannotator responds (awaitable)", async () => {
		vi.useFakeTimers();
		try {
			const { pi, emissions, fire } = createFakePi();
			let settled = false;
			const pending = requestReview(pi, "/SPEC.md", "content", "spec").then((r) => {
				settled = true;
				return r;
			});

			// Advance less than the 60s timeout — still pending.
			await vi.advanceTimersByTimeAsync(1000);
			expect(settled).toBe(false);

			const emitted = emissions.find((e) => e.channel === "plannotator:request");
			const requestId = (emitted?.data as { requestId: string }).requestId;
			fire("plannotator:review-result", { reviewId: requestId, approved: true });

			const result = await pending;
			expect(result.approved).toBe(true);
			expect(settled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("auto-approves after 10min timeout when plannotator is silent", async () => {
		vi.useFakeTimers();
		try {
			const { pi } = createFakePi();
			const pending = requestReview(pi, "/SPEC.md", "content", "spec");

			await vi.advanceTimersByTimeAsync(600_001);

			const result = await pending;
			expect(result.approved).toBe(true);
			expect(result.feedback).toContain("timed out");
		} finally {
			vi.useRealTimers();
		}
	});

	it("matches the plannotator-assigned reviewId (not our requestId)", async () => {
		const { pi, fire, emissions } = createFakePi();
		const pending = requestReview(pi, "/PLAN.md", "content", "plan");

		// Grab the request emitted on the bus and simulate plannotator's `handled`
		// response with its own reviewId (different from our internal requestId).
		const emitted = emissions.find((e) => e.channel === "plannotator:request");
		const request = emitted?.data as {
			requestId: string;
			respond: (resp: unknown) => void;
		};
		const plannotatorReviewId = "plannotator-session-xyz";
		expect(plannotatorReviewId).not.toBe(request.requestId);

		request.respond({
			status: "handled",
			result: { status: "pending", reviewId: plannotatorReviewId },
		});

		// Emit the result using plannotator's id — TFF should now match and resolve.
		fire("plannotator:review-result", {
			reviewId: plannotatorReviewId,
			approved: true,
			feedback: "lgtm",
		});

		const result = await pending;
		expect(result.approved).toBe(true);
		expect(result.feedback).toBe("lgtm");
	});
});
