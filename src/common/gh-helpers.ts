export function parsePrUrl(url: string): { repo: string; number: number } | null {
	const m = url.match(/github\.com\/([^/]+\/[^/]+?)\/pull\/(\d+)/);
	if (!m || !m[1] || !m[2]) return null;
	return { repo: m[1], number: Number.parseInt(m[2], 10) };
}
