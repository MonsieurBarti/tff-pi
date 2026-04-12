import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface ReviewResult {
	approved: boolean;
	feedback?: string;
}

export interface ReviewRequest {
	requestId: string;
	action: "plan-review";
	payload: {
		planContent: string;
		planFilePath?: string;
	};
	respond: (response: unknown) => void;
}

export function buildReviewRequest(
	requestId: string,
	artifactPath: string,
	content: string,
	_reviewType: "spec" | "plan",
): Omit<ReviewRequest, "respond"> {
	return {
		requestId,
		action: "plan-review",
		payload: {
			planContent: content,
			planFilePath: artifactPath,
		},
	};
}

export function requestReview(
	pi: ExtensionAPI,
	artifactPath: string,
	content: string,
	reviewType: "spec" | "plan",
): Promise<ReviewResult> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		const REVIEW_RESULT_CHANNEL = "plannotator:review-result";
		const REVIEW_REQUEST_CHANNEL = "plannotator:request";
		let resolved = false;
		// Plannotator mints its OWN reviewId and uses that in the result event,
		// ignoring our requestId. We must capture the plannotator-assigned id
		// from the `handled` response and match against it.
		let plannotatorReviewId: string | null = null;

		const finish = (result: ReviewResult) => {
			if (resolved) return;
			resolved = true;
			unsubscribe();
			clearTimeout(timer);
			resolve(result);
		};

		// Timeout: auto-approve after 10 minutes — gives humans real time to review
		// while still bounding hangs if plannotator crashes or the user walks away.
		const timer = setTimeout(() => {
			finish({ approved: true, feedback: "Review timed out after 10 minutes — auto-approved" });
		}, 600_000);

		const unsubscribe = pi.events.on(REVIEW_RESULT_CHANNEL, (data: unknown) => {
			const result = data as { reviewId: string; approved: boolean; feedback?: string };
			// Match against the plannotator-assigned id (learned via `handled` response).
			// Fall back to our requestId for back-compat with consumers that honor it.
			if (result.reviewId === plannotatorReviewId || result.reviewId === requestId) {
				const reviewResult: ReviewResult = { approved: result.approved };
				if (result.feedback !== undefined) {
					reviewResult.feedback = result.feedback;
				}
				finish(reviewResult);
			}
		});

		const request = buildReviewRequest(requestId, artifactPath, content, reviewType);
		pi.events.emit(REVIEW_REQUEST_CHANNEL, {
			...request,
			respond: (response: unknown) => {
				const resp = response as {
					status: string;
					result?: { reviewId?: string; status?: string };
				};
				if (resp.status === "unavailable" || resp.status === "error") {
					finish({ approved: true, feedback: "Plannotator unavailable — auto-approved" });
					return;
				}
				if (resp.status === "handled" && typeof resp.result?.reviewId === "string") {
					plannotatorReviewId = resp.result.reviewId;
				}
			},
		});
	});
}
