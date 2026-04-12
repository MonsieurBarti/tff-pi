import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
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
 * Test double for the PI event bus + plannotator response channel.
 *
 * Captures emit/on calls so tests can simulate the plannotator handshake:
 * - the `respond` callback plannotator normally invokes synchronously
 * - the `plannotator:review-result` event plannotator normally emits when
 *   the user clicks approve/reject
 */
function makeTestPi() {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const emits: Array<{ channel: string; data: unknown }> = [];

	const pi = {
		events: {
			on(channel: string, cb: (data: unknown) => void) {
				const list = listeners.get(channel) ?? [];
				list.push(cb);
				listeners.set(channel, list);
				return () => {
					const current = listeners.get(channel) ?? [];
					listeners.set(
						channel,
						current.filter((fn) => fn !== cb),
					);
				};
			},
			emit(channel: string, data: unknown) {
				emits.push({ channel, data });
				for (const cb of listeners.get(channel) ?? []) cb(data);
			},
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		emits,
		fireReviewResult(data: unknown) {
			for (const cb of listeners.get("plannotator:review-result") ?? []) cb(data);
		},
		getLastRequest(): { requestId: string; respond: (r: unknown) => void } | null {
			const reqEmit = [...emits].reverse().find((e) => e.channel === "plannotator:request");
			if (!reqEmit) return null;
			return reqEmit.data as { requestId: string; respond: (r: unknown) => void };
		},
	};
}

describe("requestReview — plannotator handshake", () => {
	it("matches review-result events against plannotator-assigned reviewId, not our requestId", async () => {
		const { pi, fireReviewResult, getLastRequest } = makeTestPi();

		const promise = requestReview(pi, "/SPEC.md", "# Spec", "spec", { timeoutMs: 2000 });

		const req = getLastRequest();
		expect(req).not.toBeNull();
		if (!req) return;

		// Plannotator accepts the request and tells us the id IT will use.
		req.respond({
			status: "handled",
			result: { status: "pending", reviewId: "plannotator-id-42" },
		});

		// A stray event with OUR requestId must NOT resolve the promise
		// (regression guard for the original bug).
		fireReviewResult({ reviewId: req.requestId, approved: true });
		// Give the microtask queue a turn.
		await new Promise((r) => setTimeout(r, 10));

		// Now fire the REAL event plannotator would send — user clicked approve.
		fireReviewResult({ reviewId: "plannotator-id-42", approved: true, feedback: "LGTM" });

		const result = await promise;
		expect(result.approved).toBe(true);
		expect(result.feedback).toBe("LGTM");
	});

	it("surfaces a rejection verdict", async () => {
		const { pi, fireReviewResult, getLastRequest } = makeTestPi();
		const promise = requestReview(pi, "/SPEC.md", "# Spec", "spec", { timeoutMs: 2000 });

		const req = getLastRequest();
		if (!req) throw new Error("no request");
		req.respond({
			status: "handled",
			result: { status: "pending", reviewId: "pl-1" },
		});
		fireReviewResult({ reviewId: "pl-1", approved: false, feedback: "Needs more detail on X" });

		const result = await promise;
		expect(result.approved).toBe(false);
		expect(result.feedback).toBe("Needs more detail on X");
	});

	it("auto-approves on unavailable response", async () => {
		const { pi, getLastRequest } = makeTestPi();
		const promise = requestReview(pi, "/SPEC.md", "# Spec", "spec", { timeoutMs: 5000 });

		const req = getLastRequest();
		if (!req) throw new Error("no request");
		req.respond({ status: "unavailable" });

		const result = await promise;
		expect(result.approved).toBe(true);
		expect(result.feedback).toMatch(/unavailable/i);
	});

	it("auto-approves on timeout when plannotator never responds", async () => {
		const { pi } = makeTestPi();
		const start = Date.now();
		const result = await requestReview(pi, "/SPEC.md", "# Spec", "spec", { timeoutMs: 100 });
		const elapsed = Date.now() - start;
		expect(result.approved).toBe(true);
		expect(result.feedback).toMatch(/timed out/i);
		expect(elapsed).toBeGreaterThanOrEqual(100);
	});

	it("ignores review-result events before plannotator has assigned an id", async () => {
		const { pi, fireReviewResult } = makeTestPi();
		const promise = requestReview(pi, "/SPEC.md", "# Spec", "spec", { timeoutMs: 300 });

		// Event arrives BEFORE plannotator responds with a reviewId — could be
		// leftover from a prior concurrent request. Must be ignored.
		fireReviewResult({ reviewId: "some-other-id", approved: false });

		// Let it sit; should still be pending.
		await new Promise((r) => setTimeout(r, 50));
		const result = await promise;
		// With no handshake completion either, we should hit the timeout path.
		expect(result.feedback).toMatch(/timed out/i);
	});
});
