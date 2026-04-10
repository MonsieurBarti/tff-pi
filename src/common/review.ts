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

		// Listen for the review result
		const unsubscribe = pi.events.on(REVIEW_RESULT_CHANNEL, (data: unknown) => {
			const result = data as {
				reviewId: string;
				approved: boolean;
				feedback?: string;
			};
			if (result.reviewId === requestId) {
				unsubscribe();
				const reviewResult: ReviewResult = { approved: result.approved };
				if (result.feedback !== undefined) {
					reviewResult.feedback = result.feedback;
				}
				resolve(reviewResult);
			}
		});

		// Emit the review request
		const request = buildReviewRequest(requestId, artifactPath, content, reviewType);
		pi.events.emit(REVIEW_REQUEST_CHANNEL, {
			...request,
			respond: (response: unknown) => {
				const resp = response as { status: string; result?: { reviewId: string } };
				if (resp.status === "unavailable" || resp.status === "error") {
					unsubscribe();
					resolve({ approved: true, feedback: "Plannotator unavailable — auto-approved" });
				}
			},
		});
	});
}
