import { execFileSync } from "node:child_process";
import { parsePrUrl } from "./gh-helpers.js";

export interface ReviewFeedback {
	markdown: string;
	commentCount: number;
}

interface Review {
	author?: { login?: string } | null;
	state?: string | null;
	body?: string | null;
}

interface Comment {
	author?: { login?: string } | null;
	body?: string | null;
	path?: string | null;
	line?: number | null;
}

interface ViewPayload {
	reviews?: Review[];
	comments?: Comment[];
}

/**
 * Raw `gh pr view` invocation. `createPRTools().view` does not expose a
 * custom `--json` selector, so we shell out directly to fetch the fields we
 * need (reviews + inline comments). Factored out so tests can stub it
 * without mocking node:child_process.
 */
export function fetchPrViewRaw(repo: string, number: number): string | null {
	try {
		return execFileSync(
			"gh",
			["pr", "view", String(number), "--repo", repo, "--json", "reviews,comments"],
			{ encoding: "utf-8" },
		);
	} catch {
		return null;
	}
}

/**
 * Fetch reviewer feedback from a slice PR via `gh pr view --json reviews,comments`.
 * Returns markdown formatted for REVIEW_FEEDBACK.md + the total number of
 * non-empty entries collected. Returns null when the URL is unparseable, the
 * gh call fails, or the PR has no feedback worth recording.
 */
export function fetchReviewFeedback(
	prUrl: string,
	fetcher: (repo: string, number: number) => string | null = fetchPrViewRaw,
): ReviewFeedback | null {
	const parsed = parsePrUrl(prUrl);
	if (!parsed) return null;

	const raw = fetcher(parsed.repo, parsed.number);
	if (!raw) return null;

	let data: ViewPayload;
	try {
		data = JSON.parse(raw) as ViewPayload;
	} catch {
		return null;
	}

	const reviews = data.reviews ?? [];
	const comments = data.comments ?? [];

	const lines: string[] = [];
	const reviewBodies = reviews.filter((r): r is Review => {
		const body = r.body;
		return typeof body === "string" && body.trim().length > 0;
	});

	if (reviewBodies.length > 0) {
		lines.push("## Reviews", "");
		for (const r of reviewBodies) {
			const author = r.author?.login ?? "unknown";
			const state = r.state ?? "COMMENTED";
			lines.push(`### @${author} — ${state}`, "", (r.body ?? "").trim(), "");
		}
	}

	const inlineComments = comments.filter((c): c is Comment => {
		const body = c.body;
		return typeof body === "string" && body.trim().length > 0;
	});

	if (inlineComments.length > 0) {
		lines.push("## Inline Comments", "");
		for (const c of inlineComments) {
			const author = c.author?.login ?? "unknown";
			const loc = c.path ? ` ${c.path}${c.line ? `:${c.line}` : ""}` : "";
			const body = (c.body ?? "").trim().split("\n").join(" ");
			lines.push(`- @${author}${loc}: ${body}`);
		}
		lines.push("");
	}

	const count = reviewBodies.length + inlineComments.length;
	if (count === 0) return null;

	return { markdown: lines.join("\n"), commentCount: count };
}
