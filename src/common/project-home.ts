import { homedir } from "node:os";
import { join } from "node:path";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectHomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectHomeError";
	}
}

export function tffHomeRoot(): string {
	const override = process.env.TFF_HOME;
	if (override && override.length > 0) return override;
	return join(homedir(), ".tff");
}

export function isUuidV4(s: string): boolean {
	return UUID_V4_RE.test(s);
}
