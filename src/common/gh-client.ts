import { type GHClient, createGHClient, createPRTools } from "@the-forge-flow/gh-pi";

let cachedClient: GHClient | null = null;

export function getGhClient(): GHClient {
	if (!cachedClient) {
		cachedClient = createGHClient();
	}
	return cachedClient;
}

export function getPrTools() {
	return createPRTools(getGhClient());
}

export function resetGhClient(): void {
	cachedClient = null;
}
