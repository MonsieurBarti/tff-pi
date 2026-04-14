import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { insertEventLog, insertPhaseRun, updatePhaseRun } from "./db.js";
import { type EventBus, type PhaseEvent, TFF_CHANNELS, type TffChannel } from "./events.js";

export class EventLogger {
	private static readonly MAX_EVENT_LOG_ROWS = 10_000;
	private static readonly MAX_JSONL_BYTES = 10 * 1024 * 1024; // 10MB
	private static readonly MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB

	private activePhaseRuns = new Map<string, string>(); // "sliceId:phase" → phaseRunId
	private unsubscribers: Array<() => void> = [];

	constructor(
		private db: Database.Database,
		private logsDir: string,
	) {
		mkdirSync(logsDir, { recursive: true });
	}

	subscribe(events: EventBus): void {
		this.pruneIfNeeded();
		for (const channel of TFF_CHANNELS) {
			const unsub = events.on(channel, (data) => {
				try {
					const event = data as {
						type: string;
						sliceId: string | null;
						sliceLabel: string | null;
						timestamp: string;
					} & Record<string, unknown>;
					this.writeEventLog(channel, event);
					this.appendJsonl(channel, event);
					if (channel === "tff:phase") {
						this.handlePhaseRun(event as unknown as PhaseEvent);
					}
				} catch {
					// Monitoring must not fail the pipeline
				}
			});
			this.unsubscribers.push(unsub);
		}
	}

	dispose(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
	}

	pruneIfNeeded(): void {
		const count = (this.db.prepare("SELECT COUNT(*) as c FROM event_log").get() as { c: number }).c;
		if (count > EventLogger.MAX_EVENT_LOG_ROWS) {
			const keep = Math.floor(EventLogger.MAX_EVENT_LOG_ROWS * 0.8);
			this.db
				.prepare(
					"DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT ?)",
				)
				.run(keep);
		}
	}

	private sanitizeFilename(label: string): string {
		// sliceLabel format is always M##-S## from sliceLabel() in types.ts
		// Strip anything that's not alphanumeric, dash, or underscore
		return label.replace(/[^a-zA-Z0-9_-]/g, "_");
	}

	private truncatePayload(event: { type: string } & Record<string, unknown>): string {
		const full = JSON.stringify(event);
		if (full.length <= EventLogger.MAX_PAYLOAD_BYTES) return full;

		// Rebuild with stubbed large fields so the payload stays parseable JSON.
		// Keep all non-payload fields (type, ids, phase, timestamps, etc.) and
		// replace input/output with markers.
		const truncated: Record<string, unknown> = { ...event };
		truncated.input = "[truncated: payload exceeded MAX_PAYLOAD_BYTES]";
		truncated.output = "[truncated: payload exceeded MAX_PAYLOAD_BYTES]";
		truncated.truncated = true;

		const retry = JSON.stringify(truncated);
		if (retry.length <= EventLogger.MAX_PAYLOAD_BYTES) return retry;

		// Extremely pathological case — even the metadata envelope is too large.
		// Fall back to a minimal valid-JSON envelope.
		return JSON.stringify({
			type: event.type,
			truncated: true,
			reason: "event envelope exceeded MAX_PAYLOAD_BYTES",
		});
	}

	private truncateString(s: string, maxLen = 2000): string {
		return s.length > maxLen ? `${s.substring(0, maxLen)}…[truncated]` : s;
	}

	private writeEventLog(
		channel: TffChannel,
		event: { type: string; sliceId: string | null } & Record<string, unknown>,
	): void {
		const payload = this.truncatePayload(event);
		insertEventLog(this.db, {
			channel,
			type: event.type,
			// event_log.slice_id is NOT NULL (db.ts:134); coerce null → empty string
			sliceId: event.sliceId ?? "",
			payload,
		});
	}

	private appendJsonl(
		channel: TffChannel,
		event: { timestamp: string; type: string; sliceLabel: string | null } & Record<string, unknown>,
	): void {
		const line = JSON.stringify({ ts: event.timestamp, ch: channel, ...event });
		const fileName = event.sliceLabel
			? `${this.sanitizeFilename(event.sliceLabel)}.jsonl`
			: "ambient.jsonl";
		const filePath = join(this.logsDir, fileName);
		appendFileSync(filePath, `${line}\n`);
	}

	private handlePhaseRun(event: PhaseEvent): void {
		const key = `${event.sliceId}:${event.phase}`;

		if (event.type === "phase_start") {
			const id = insertPhaseRun(this.db, {
				sliceId: event.sliceId,
				phase: event.phase,
				status: "started",
				startedAt: event.timestamp,
			});
			this.activePhaseRuns.set(key, id);
			return;
		}

		const runId = this.activePhaseRuns.get(key);
		if (!runId) return;

		const statusMap: Record<string, string> = {
			phase_complete: "completed",
			phase_failed: "failed",
			phase_retried: "retried",
		};

		const metadata: Record<string, unknown> = {};
		if (event.tier) metadata.tier = event.tier;

		const update: Parameters<typeof updatePhaseRun>[2] = {
			status: statusMap[event.type] ?? event.type,
			finishedAt: event.timestamp,
		};
		if (event.durationMs !== undefined) update.durationMs = event.durationMs;
		if (event.error !== undefined) update.error = this.truncateString(event.error);
		if (event.feedback !== undefined) update.feedback = this.truncateString(event.feedback);
		if (Object.keys(metadata).length > 0) update.metadata = JSON.stringify(metadata);

		updatePhaseRun(this.db, runId, update);

		if (event.type !== "phase_retried") {
			this.activePhaseRuns.delete(key);
		}
	}
}
