import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { insertEventLog, insertPhaseRun, updatePhaseRun } from "./db.js";
import { type PhaseEvent, TFF_CHANNELS, type TffChannel, type TffEvent } from "./events.js";

interface EventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export class EventLogger {
	private activePhaseRuns = new Map<string, string>(); // "sliceId:phase" → phaseRunId

	constructor(
		private db: Database.Database,
		private logsDir: string,
	) {
		mkdirSync(logsDir, { recursive: true });
	}

	subscribe(events: EventBus): void {
		for (const channel of TFF_CHANNELS) {
			events.on(channel, (data) => {
				const event = data as TffEvent & { type: string };
				this.writeEventLog(channel, event);
				this.appendJsonl(channel, event);
				if (channel === "tff:phase") {
					this.handlePhaseRun(event as PhaseEvent);
				}
			});
		}
	}

	private writeEventLog(channel: TffChannel, event: TffEvent & { type: string }): void {
		insertEventLog(this.db, {
			channel,
			type: event.type,
			sliceId: event.sliceId,
			payload: JSON.stringify(event),
		});
	}

	private appendJsonl(channel: TffChannel, event: TffEvent & { type: string }): void {
		const line = JSON.stringify({ ts: event.timestamp, ch: channel, ...event });
		const filePath = join(this.logsDir, `${event.sliceLabel}.jsonl`);
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
		if (event.error !== undefined) update.error = event.error;
		if (event.feedback !== undefined) update.feedback = event.feedback;
		if (Object.keys(metadata).length > 0) update.metadata = JSON.stringify(metadata);

		updatePhaseRun(this.db, runId, update);

		if (event.type !== "phase_retried") {
			this.activePhaseRuns.delete(key);
		}
	}
}
