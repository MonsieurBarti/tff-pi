import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, TffChannel } from "./events.js";
import { logWarning } from "./logger.js";

// pi.events.emit is synchronous today. If it becomes async, ordering against
// the post-commit emit in writer tools may break — audit callsites.
const CHANNELS_TO_LOG: TffChannel[] = [
	"tff:phase",
	"tff:task",
	"tff:wave",
	"tff:review",
	"tff:pipeline",
	"tff:tool",
	"tff:derived",
	"tff:override",
	"tff:state-rename",
];

function sanitizeFilename(label: string): string {
	return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function logsDir(root: string): string {
	return join(root, ".tff", "logs");
}

export interface PerSliceLogLine {
	ts?: string;
	ch: string;
	[k: string]: unknown;
}

export class PerSliceLog {
	private unsubscribers: Array<() => void> = [];
	private dir: string;

	constructor(root: string) {
		this.dir = logsDir(root);
		mkdirSync(this.dir, { recursive: true });
	}

	subscribe(events: EventBus): void {
		for (const channel of CHANNELS_TO_LOG) {
			const unsub = events.on(channel, (data) => {
				const event = data as {
					timestamp?: string;
					sliceLabel: string | null;
				} & Record<string, unknown>;
				const fileName = event.sliceLabel
					? `${sanitizeFilename(event.sliceLabel)}.jsonl`
					: "ambient.jsonl";
				const line = JSON.stringify({
					ts: event.timestamp,
					ch: channel,
					...event,
				});
				appendFileSync(join(this.dir, fileName), `${line}\n`);
			});
			this.unsubscribers.push(unsub);
		}
	}

	dispose(): void {
		for (const u of this.unsubscribers) u();
		this.unsubscribers = [];
	}
}

/**
 * Read per-slice JSONL lines, or ambient. `label` may be a slice label like
 * "M01-S01" or "ambient". Returns [] when the file doesn't exist.
 */
export function readPerSliceLog(root: string, label: string): PerSliceLogLine[] {
	const fileName = label === "ambient" ? "ambient.jsonl" : `${sanitizeFilename(label)}.jsonl`;
	const path = join(logsDir(root), fileName);
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf-8");
	if (raw.length === 0) return [];
	const out: PerSliceLogLine[] = [];
	for (const [i, l] of raw
		.split("\n")
		.filter((l) => l.length > 0)
		.entries()) {
		try {
			out.push(JSON.parse(l) as PerSliceLogLine);
		} catch (err) {
			logWarning("artifact", "malformed-slice-log-line", {
				id: label,
				row: String(i + 1),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}
